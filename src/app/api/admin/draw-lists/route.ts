/**
 * GET  /api/admin/draw-lists  抽選リスト一覧（自分が作ったもののみ）
 * POST /api/admin/draw-lists  抽選リストの新規作成
 */

import { createDrawList, listDrawLists } from '@/application/services/draw-list-service';
import { jsonCreated, jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody, withRoute } from '@/lib/http/route-helpers';
import { createDrawListSchema } from '@/lib/validation/schemas';
import type { DrawListDetailResponse, DrawListsResponse } from '@/types/api';

export const dynamic = 'force-dynamic';

export const GET = withRoute<DrawListsResponse>('admin.draw_lists.list', async () => {
  // 所有者の絞り込みはサービス層（requireHostUser + ownerId）で行う。
  const lists = await listDrawLists();
  return jsonOk<DrawListsResponse>({ lists });
});

export const POST = withRoute<DrawListDetailResponse>(
  'admin.draw_lists.create',
  async ({ request }) => {
    assertSameOrigin(request);

    const input = await parseJsonBody(request, createDrawListSchema);
    const list = await createDrawList(input);

    return jsonCreated<DrawListDetailResponse>({ list });
  },
);
