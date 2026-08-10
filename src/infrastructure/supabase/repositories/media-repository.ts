import 'server-only';

/**
 * media_assets テーブルへのアクセス。
 *
 * 呼び出し前に必ず所有者検証を済ませること（RLS 迂回の管理クライアントを使うため）。
 */

import { createSupabaseAdminClient } from '@/infrastructure/supabase/admin';
import { throwIfDbError } from '@/infrastructure/supabase/repositories/db-errors';
import { buildStorageRef } from '@/infrastructure/supabase/storage/media-storage';
import { AppError } from '@/lib/errors/app-error';
import type { MediaAssetRecord, MediaRepository } from '@/application/ports/media-storage-port';
import type { MediaAssetRow } from '@/types/database';

function toRecord(row: MediaAssetRow): MediaAssetRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    bucket: row.bucket,
    objectPath: row.object_path,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

export async function insertAsset(
  input: Omit<MediaAssetRecord, 'createdAt'>,
): Promise<MediaAssetRecord> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('media_assets')
    .insert({
      id: input.id,
      owner_id: input.ownerId,
      bucket: input.bucket,
      object_path: input.objectPath,
      mime_type: input.mimeType,
      byte_size: input.byteSize,
      width: input.width,
      height: input.height,
    })
    .select('*')
    .single();

  throwIfDbError(error);
  if (!data) {
    throw new AppError('MEDIA_PROCESSING_FAILED');
  }
  return toRecord(data);
}

export async function getAsset(assetId: string): Promise<MediaAssetRecord | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('media_assets')
    .select('*')
    .eq('id', assetId)
    .maybeSingle();

  throwIfDbError(error);
  return data ? toRecord(data) : null;
}

export async function deleteAsset(assetId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('media_assets').delete().eq('id', assetId);
  throwIfDbError(error);
}

/** この画像が問題・選択肢から参照されている件数。 */
export async function countUsages(assetId: string): Promise<number> {
  const admin = createSupabaseAdminClient();

  const questionUsage = await admin
    .from('questions')
    .select('id', { count: 'exact', head: true })
    .or(`question_image_asset_id.eq.${assetId},reveal_image_asset_id.eq.${assetId}`);
  throwIfDbError(questionUsage.error);

  const choiceUsage = await admin
    .from('choices')
    .select('id', { count: 'exact', head: true })
    .eq('image_asset_id', assetId);
  throwIfDbError(choiceUsage.error);

  return (questionUsage.count ?? 0) + (choiceUsage.count ?? 0);
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

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('media_assets')
    .select('id,bucket,object_path,width,height')
    .in('id', unique);

  throwIfDbError(error);

  for (const row of data ?? []) {
    result.set(row.id, {
      ref: buildStorageRef(row.bucket, row.object_path),
      width: row.width,
      height: row.height,
    });
  }
  return result;
}

export const mediaRepository: MediaRepository = {
  insertAsset,
  getAsset,
  deleteAsset,
  countUsages,
  getAssetRefs,
};
