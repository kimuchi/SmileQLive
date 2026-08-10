import 'server-only';

/**
 * `mediaAssets/{assetId}` へのアクセス。
 *
 * - 呼び出し前に必ず所有者検証を済ませること（Admin SDK は Security Rules を迂回する）。
 * - 保存するのは WebP へ変換済みの画像だけ。
 * - Firestore へは `storage://<bucket>/<objectPath>` 参照のみを保存し、
 *   期限付き URL は配信直前に解決する。
 */

import { getDb } from '@/infrastructure/firebase/admin';
import {
  mediaAssetRef,
  mediaAssetsCollection,
  questionsCollection,
  quizzesCollection,
} from '@/infrastructure/firebase/paths';
import {
  isRecord,
  nowTimestamp,
  readInt,
  readString,
  toIsoOr,
  type MediaAssetLookup,
} from '@/infrastructure/firebase/converters';
import { buildStorageRef, resolveMediaUrls } from '@/infrastructure/firebase/storage/media-storage';
import { OUTPUT_MIME_TYPE } from '@/domain/media/image-policy';
import { AppError } from '@/lib/errors/app-error';
import type { MediaAssetRecord, MediaRepository } from '@/application/ports/media-storage-port';
import type { MediaAssetDoc } from '@/types/firestore';

function toRecord(doc: MediaAssetDoc): MediaAssetRecord {
  return {
    id: doc.id,
    ownerId: doc.ownerId,
    bucket: doc.bucket,
    objectPath: doc.objectPath,
    mimeType: doc.mimeType,
    byteSize: doc.byteSize,
    width: doc.width,
    height: doc.height,
    createdAt: toIsoOr(doc.createdAt),
  };
}

export async function insertAsset(
  input: Omit<MediaAssetRecord, 'createdAt'>,
): Promise<MediaAssetRecord> {
  const createdAt = nowTimestamp();
  const doc: MediaAssetDoc = {
    id: input.id,
    ownerId: input.ownerId,
    bucket: input.bucket,
    objectPath: input.objectPath,
    // 保存するのは WebP だけ（media-service が変換済み）。
    mimeType: OUTPUT_MIME_TYPE,
    byteSize: input.byteSize,
    width: input.width,
    height: input.height,
    createdAt,
  };

  await mediaAssetRef(input.id).create(doc);
  return toRecord(doc);
}

export async function getAsset(assetId: string): Promise<MediaAssetRecord | null> {
  const snapshot = await mediaAssetRef(assetId).get();
  const data = snapshot.data();
  return data ? toRecord(data) : null;
}

export async function deleteAsset(assetId: string): Promise<void> {
  await mediaAssetRef(assetId).delete();
}

/**
 * この画像が問題・選択肢から参照されている件数。
 *
 * Firestore ではコレクショングループの索引を追加せずに
 * `questions` 全体を横断検索できないため、**所有者のクイズだけ**を走査する。
 * 画像削除は管理画面のまれな操作なので、この読み取り量は許容する。
 */
export async function countUsages(assetId: string): Promise<number> {
  const asset = await getAsset(assetId);
  if (!asset) {
    return 0;
  }

  const quizzes = await quizzesCollection().where('ownerId', '==', asset.ownerId).get();

  let usages = 0;
  for (const quiz of quizzes.docs) {
    const questions = await questionsCollection(quiz.id).get();
    for (const question of questions.docs) {
      const data = question.data();
      if (data.questionImageAssetId === assetId) {
        usages += 1;
      }
      if (data.revealImageAssetId === assetId) {
        usages += 1;
      }
      for (const choice of data.choices) {
        if (choice.imageAssetId === assetId) {
          usages += 1;
        }
      }
    }
  }

  return usages;
}

/**
 * assetId から `storage://` 参照とサイズを引く。
 * 管理画面・スナップショット生成で複数枚をまとめて解決するために使う。
 */
export async function getAssetRefs(
  assetIds: string[],
): Promise<Map<string, { ref: string; width: number; height: number }>> {
  const unique = [...new Set(assetIds.filter((id) => id.length > 0))];
  const result = new Map<string, { ref: string; width: number; height: number }>();
  if (unique.length === 0) {
    return result;
  }

  // getAll は 1 回の RPC でまとめて読む（1 件ずつ get しない）。
  // Firestore.getAll() は型引数を取らないため、戻り値は防御的に読む。
  const snapshots = await getDb().getAll(
    ...unique.map((assetId) => mediaAssetsCollection().doc(assetId)),
  );

  for (const snapshot of snapshots) {
    const data: unknown = snapshot.data();
    if (!isRecord(data)) {
      continue;
    }
    const id = readString(data, 'id');
    const bucket = readString(data, 'bucket');
    const objectPath = readString(data, 'objectPath');
    if (!id || !bucket || !objectPath) {
      continue;
    }
    result.set(id, {
      ref: buildStorageRef(bucket, objectPath),
      width: readInt(data, 'width', 0),
      height: readInt(data, 'height', 0),
    });
  }
  return result;
}

/**
 * 画像 ID の一覧から、表示用の参照表を作る。
 *
 * `resolveUrls: false`（既定は true）のときは `storage://` 参照のまま返す。
 * ルーム作成時のスナップショットには**期限付き URL を保存しない**ため必ず false で呼ぶこと。
 */
export async function buildMediaLookup(
  assetIds: (string | null)[],
  options: { resolveUrls?: boolean } = {},
): Promise<MediaAssetLookup> {
  const ids = assetIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  const refs = await getAssetRefs(ids);
  const lookup = new Map<string, { url: string; width: number; height: number }>();

  const entries = [...refs.entries()];
  if (entries.length === 0) {
    return lookup;
  }

  if (options.resolveUrls === false) {
    for (const [assetId, ref] of entries) {
      lookup.set(assetId, { url: ref.ref, width: ref.width, height: ref.height });
    }
    return lookup;
  }

  const urls = await resolveMediaUrls(entries.map(([, ref]) => ref.ref));
  entries.forEach(([assetId, ref], index) => {
    const url = urls[index];
    if (!url) {
      return;
    }
    lookup.set(assetId, { url, width: ref.width, height: ref.height });
  });
  return lookup;
}

/** 画像メタデータが見つからない場合に投げる。 */
export async function requireAsset(assetId: string): Promise<MediaAssetRecord> {
  const asset = await getAsset(assetId);
  if (!asset) {
    throw new AppError('MEDIA_NOT_FOUND');
  }
  return asset;
}

export const mediaRepository: MediaRepository = {
  insertAsset,
  getAsset,
  deleteAsset,
  countUsages,
  getAssetRefs,
};
