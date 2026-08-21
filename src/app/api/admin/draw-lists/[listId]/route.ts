/**
 * GET    /api/admin/draw-lists/[listId]  抽選リストの中身
 * PATCH  /api/admin/draw-lists/[listId]  名前・数字の範囲・演出の設定を更新
 * DELETE /api/admin/draw-lists/[listId]  削除
 */

import {
  deleteDrawList,
  getDrawList,
  updateDrawList,
} from '@/application/services/draw-list-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody } from '@/lib/http/route-helpers';
import { updateDrawListSchema } from '@/lib/validation/schemas';
import type { DrawListDetailResponse } from '@/types/api';
import {
  requireUuidParam,
  withParams,
  type DeletedResponse,
} from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { listId: string };

export const GET = withParams<Params>('admin.draw_lists.get', async (_request, ctx) => {
  const listId = requireUuidParam(ctx.params.listId, 'listId');
  const list = await getDrawList(listId);
  return jsonOk<DrawListDetailResponse>({ list });
});

export const PATCH = withParams<Params>('admin.draw_lists.update', async (request, ctx) => {
  assertSameOrigin(request);

  const listId = requireUuidParam(ctx.params.listId, 'listId');
  const input = await parseJsonBody(request, updateDrawListSchema);

  // 所有権はサービス層で確認する。
  const list = await updateDrawList(listId, input);
  return jsonOk<DrawListDetailResponse>({ list });
});

export const DELETE = withParams<Params>('admin.draw_lists.delete', async (request, ctx) => {
  assertSameOrigin(request);

  const listId = requireUuidParam(ctx.params.listId, 'listId');
  await deleteDrawList(listId);

  return jsonOk<DeletedResponse>({ deleted: true });
});
