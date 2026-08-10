import 'server-only';

/**
 * Cloud Storage への画像保存と配信 URL の解決。
 *
 * 設計:
 * - Firestore（クイズスナップショットを含む）へ**期限付き URL を保存しない**。
 *   `storage://<bucket>/<objectPath>` 形式の参照だけを保存し、配信直前に解決する。
 * - Storage の Security Rules はクライアントからの読み取りも全拒否しているため、
 *   配信は必ず**署名付き URL（有効期限 1 時間）**で行う。
 * - 保存パスに正解を推測できる語を含めない（buildObjectPath が担保）。
 * - 署名はサービスアカウント（ADC）で行う。Cloud Run では IAM の SignBlob 呼び出しになるため、
 *   同一オブジェクトの再署名を避けるプロセス内キャッシュを持つ。
 */

import { getAdminStorage, getMediaBucket } from '@/infrastructure/firebase/admin';
import { logger } from '@/infrastructure/logging/logger';
import { buildObjectPath, OUTPUT_MIME_TYPE } from '@/domain/media/image-policy';
import { AppError } from '@/lib/errors/app-error';
import type {
  MediaStorage,
  UploadProcessedImageInput,
} from '@/application/ports/media-storage-port';

export const STORAGE_REF_SCHEME = 'storage://';

/** 署名付き URL の有効期間 (秒)。 */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** 署名結果を使い回す時間 (ミリ秒)。期限より十分短くする。 */
const SIGNED_URL_CACHE_TTL_MS = (SIGNED_URL_TTL_SECONDS - 5 * 60) * 1000;

/** 既定バケット名（Firebase Admin の初期化設定から解決する）。 */
export function mediaBucketName(): string {
  return getMediaBucket().name;
}

/** `@google-cloud/storage` は直接の依存ではないため、型は Admin SDK 経由で導出する。 */
type MediaBucket = ReturnType<typeof getMediaBucket>;

/** 参照が指すバケット。既定バケット以外の参照（移行途中の古いデータ）も扱えるようにする。 */
function bucketFor(bucket: string): MediaBucket {
  const fallback = getMediaBucket();
  return bucket === fallback.name ? fallback : getAdminStorage().bucket(bucket);
}

/** `storage://<bucket>/<objectPath>` を組み立てる。 */
export function buildStorageRef(bucket: string, objectPath: string): string {
  return `${STORAGE_REF_SCHEME}${bucket}/${objectPath}`;
}

export type ParsedStorageRef =
  { kind: 'storage'; bucket: string; objectPath: string } | { kind: 'url'; url: string };

/**
 * 参照文字列を bucket と objectPath へ分解する。
 * `storage://` が無い場合は既定バケットの objectPath とみなす。
 * すでに http(s) の URL ならそのまま扱う。
 */
export function parseStorageRef(ref: string): ParsedStorageRef | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { kind: 'url', url: trimmed };
  }
  if (trimmed.startsWith(STORAGE_REF_SCHEME)) {
    const rest = trimmed.slice(STORAGE_REF_SCHEME.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) {
      return null;
    }
    return { kind: 'storage', bucket: rest.slice(0, slash), objectPath: rest.slice(slash + 1) };
  }
  return { kind: 'storage', bucket: mediaBucketName(), objectPath: trimmed.replace(/^\/+/, '') };
}

// ---------------------------------------------------------------------------
// アップロード・削除
// ---------------------------------------------------------------------------

/**
 * 変換済み (WebP) 画像を保存する。
 * 変換・検証は media-service 側で完了している前提。
 */
export async function uploadProcessedImage(
  input: UploadProcessedImageInput,
): Promise<{ objectPath: string }> {
  const bucket = getMediaBucket();
  const objectPath = buildObjectPath(input.ownerId, input.quizId, input.assetId);

  try {
    await bucket.file(objectPath).save(input.buffer, {
      resumable: false,
      contentType: input.contentType || OUTPUT_MIME_TYPE,
      metadata: { cacheControl: 'private, max-age=31536000, immutable' },
    });
  } catch (error) {
    logger.error('storage.upload_failed', {
      bucket: bucket.name,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw new AppError('MEDIA_PROCESSING_FAILED', { cause: error });
  }

  return { objectPath };
}

/** オブジェクトを削除する。参照文字列でも objectPath でも受け付ける。 */
export async function deleteObject(objectPath: string): Promise<void> {
  const parsed = parseStorageRef(objectPath);
  if (!parsed || parsed.kind !== 'storage') {
    return;
  }

  signedUrlCache.delete(cacheKey(parsed.bucket, parsed.objectPath));

  try {
    await bucketFor(parsed.bucket).file(parsed.objectPath).delete();
  } catch (error) {
    // 実体が既に無い場合もあるため、削除失敗は警告に留める（メタデータ削除は継続する）。
    logger.warn('storage.remove_failed', {
      bucket: parsed.bucket,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// URL 解決
// ---------------------------------------------------------------------------

type CachedSignedUrl = { url: string; expiresAtMs: number };

/** 署名付き URL のプロセス内キャッシュ。進行状態ではないのでインスタンスごとに独立でよい。 */
const signedUrlCache = new Map<string, CachedSignedUrl>();

function cacheKey(bucket: string, objectPath: string): string {
  return `${bucket}/${objectPath}`;
}

/** テスト用にキャッシュを破棄する。 */
export function resetSignedUrlCache(): void {
  signedUrlCache.clear();
}

async function signOne(bucket: string, objectPath: string): Promise<string | null> {
  const key = cacheKey(bucket, objectPath);
  const now = Date.now();
  const cached = signedUrlCache.get(key);
  if (cached && cached.expiresAtMs > now) {
    return cached.url;
  }

  try {
    const [url] = await bucketFor(bucket)
      .file(objectPath)
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: now + SIGNED_URL_TTL_SECONDS * 1000,
      });
    signedUrlCache.set(key, { url, expiresAtMs: now + SIGNED_URL_CACHE_TTL_MS });
    return url;
  } catch (error) {
    logger.warn('storage.sign_failed', {
      bucket,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 単一の参照を配信 URL へ解決する。null 入力は null。 */
export async function resolveMediaUrl(ref: string | null): Promise<string | null> {
  if (!ref) {
    return null;
  }
  const resolved = await resolveMediaUrls([ref]);
  return resolved[0] ?? null;
}

/**
 * 複数の参照をまとめて解決する。
 * 同一バケット・同一パスの重複は 1 回の署名にまとめる。
 * 入力と同じ長さ・同じ順序の配列を返す。
 */
export async function resolveMediaUrls(refs: (string | null)[]): Promise<(string | null)[]> {
  const results: (string | null)[] = refs.map(() => null);

  /** bucket -> objectPath -> 出力先インデックス一覧 */
  const pending = new Map<string, Map<string, number[]>>();

  refs.forEach((ref, index) => {
    if (!ref) {
      return;
    }
    const parsed = parseStorageRef(ref);
    if (!parsed) {
      return;
    }
    if (parsed.kind === 'url') {
      results[index] = parsed.url;
      return;
    }
    const byPath = pending.get(parsed.bucket) ?? new Map<string, number[]>();
    const indexes = byPath.get(parsed.objectPath) ?? [];
    indexes.push(index);
    byPath.set(parsed.objectPath, indexes);
    pending.set(parsed.bucket, byPath);
  });

  if (pending.size === 0) {
    return results;
  }

  for (const [bucket, byPath] of pending) {
    const paths = [...byPath.keys()];
    const signed = await Promise.all(paths.map((path) => signOne(bucket, path)));

    paths.forEach((path, pathIndex) => {
      const url = signed[pathIndex] ?? null;
      for (const index of byPath.get(path) ?? []) {
        results[index] = url;
      }
    });
  }

  return results;
}

export const mediaStorage: MediaStorage = {
  uploadProcessedImage,
  deleteObject,
  resolveMediaUrl,
  resolveMediaUrls,
};
