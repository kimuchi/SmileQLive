/**
 * DELETE /api/admin/media/[assetId]  画像の削除
 *
 * 問題・選択肢から参照されている画像はサービス層が MEDIA_IN_USE で拒否する。
 */

import { deleteAsset } from '@/application/services/media-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin } from '@/lib/http/route-helpers';
import {
  requireUuidParam,
  withParams,
  type DeletedResponse,
} from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { assetId: string };

export const DELETE = withParams<Params>('admin.media.delete', async (request, ctx) => {
  assertSameOrigin(request);

  const assetId = requireUuidParam(ctx.params.assetId, 'assetId');

  // 所有者の照合はサービス層（asset.ownerId と認証ユーザーの突き合わせ）で行う。
  await deleteAsset(assetId);

  return jsonOk<DeletedResponse>({ deleted: true });
});
