import 'server-only';

/**
 * Supabase Storage への画像保存と配信 URL 解決。
 *
 * 設計:
 * - クイズスナップショット・DB には**期限付き URL を保存しない**。
 *   `storage://<bucket>/<object_path>` 形式の参照だけを保存し、
 *   配信直前に公開 URL または署名付き URL へ解決する。
 * - バケットが public なら公開 URL、private なら 1 時間有効の署名付き URL を返す。
 * - 保存パスに正解を推測できる語を含めない（buildObjectPath が担保）。
 */

import { createSupabaseAdminClient } from '@/infrastructure/supabase/admin';
import { logger } from '@/infrastructure/logging/logger';
import { buildObjectPath, OUTPUT_MIME_TYPE } from '@/domain/media/image-policy';
import { AppError } from '@/lib/errors/app-error';
import { quizMediaBucket } from '@/lib/env/server-env';

export const STORAGE_REF_SCHEME = 'storage://';

/** 署名付き URL の有効期間 (秒)。 */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** `storage://<bucket>/<path>` を組み立てる。 */
export function buildStorageRef(bucket: string, objectPath: string): string {
  return `${STORAGE_REF_SCHEME}${bucket}/${objectPath}`;
}

/**
 * 参照文字列を bucket と object_path へ分解する。
 * `storage://` が無い場合は既定バケットの object_path とみなす。
 * すでに http(s) の URL ならそのまま扱えるよう null を返す。
 */
export function parseStorageRef(
  ref: string,
): { kind: 'storage'; bucket: string; objectPath: string } | { kind: 'url'; url: string } | null {
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
  return { kind: 'storage', bucket: quizMediaBucket(), objectPath: trimmed.replace(/^\/+/, '') };
}

// ---------------------------------------------------------------------------
// バケット公開設定のキャッシュ
// ---------------------------------------------------------------------------
// 進行状態ではなく「構成情報」のキャッシュ。インスタンスごとに独立していて問題ない。
type BucketVisibility = { isPublic: boolean; fetchedAt: number };
const BUCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const bucketCache = new Map<string, BucketVisibility>();

async function isPublicBucket(bucket: string): Promise<boolean> {
  const cached = bucketCache.get(bucket);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < BUCKET_CACHE_TTL_MS) {
    return cached.isPublic;
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.storage.getBucket(bucket);
  if (error || !data) {
    // 取得できないときは安全側（private 扱い＝署名付き URL）へ倒す。
    logger.warn('storage.get_bucket_failed', { bucket, errorMessage: error?.message });
    bucketCache.set(bucket, { isPublic: false, fetchedAt: now });
    return false;
  }

  bucketCache.set(bucket, { isPublic: data.public === true, fetchedAt: now });
  return data.public === true;
}

/** テスト用にバケット情報のキャッシュを破棄する。 */
export function resetBucketCache(): void {
  bucketCache.clear();
}

// ---------------------------------------------------------------------------
// アップロード・削除
// ---------------------------------------------------------------------------

export type UploadProcessedImageInput = {
  ownerId: string;
  quizId: string;
  assetId: string;
  buffer: Uint8Array;
  contentType: string;
};

/**
 * 変換済み (WebP) 画像を保存する。
 * 変換・検証は media-service 側で完了している前提。
 */
export async function uploadProcessedImage(
  input: UploadProcessedImageInput,
): Promise<{ objectPath: string }> {
  const bucket = quizMediaBucket();
  const objectPath = buildObjectPath(input.ownerId, input.quizId, input.assetId);
  const admin = createSupabaseAdminClient();

  const { error } = await admin.storage.from(bucket).upload(objectPath, input.buffer, {
    contentType: input.contentType || OUTPUT_MIME_TYPE,
    cacheControl: '31536000',
    upsert: false,
  });

  if (error) {
    logger.error('storage.upload_failed', { bucket, errorMessage: error.message });
    throw new AppError('MEDIA_PROCESSING_FAILED', { cause: error });
  }

  return { objectPath };
}

/** オブジェクトを削除する。参照文字列でも object_path でも受け付ける。 */
export async function deleteObject(objectPath: string): Promise<void> {
  const parsed = parseStorageRef(objectPath);
  if (!parsed || parsed.kind !== 'storage') {
    return;
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin.storage.from(parsed.bucket).remove([parsed.objectPath]);
  if (error) {
    // 実体が既に無い場合もあるため、削除失敗は警告に留める（メタデータ削除は継続する）。
    logger.warn('storage.remove_failed', {
      bucket: parsed.bucket,
      errorMessage: error.message,
    });
  }
}

// ---------------------------------------------------------------------------
// URL 解決
// ---------------------------------------------------------------------------

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
 * 同一バケットの private オブジェクトは createSignedUrls で 1 回にまとめる。
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

  const admin = createSupabaseAdminClient();

  for (const [bucket, byPath] of pending) {
    const paths = [...byPath.keys()];
    const publicBucket = await isPublicBucket(bucket);

    if (publicBucket) {
      for (const path of paths) {
        const { data } = admin.storage.from(bucket).getPublicUrl(path);
        for (const index of byPath.get(path) ?? []) {
          results[index] = data.publicUrl;
        }
      }
      continue;
    }

    const { data, error } = await admin.storage
      .from(bucket)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);

    if (error || !data) {
      logger.warn('storage.sign_failed', { bucket, errorMessage: error?.message });
      continue;
    }

    for (const entry of data) {
      const path = entry.path;
      if (!path || !entry.signedUrl) {
        continue;
      }
      for (const index of byPath.get(path) ?? []) {
        results[index] = entry.signedUrl;
      }
    }
  }

  return results;
}
