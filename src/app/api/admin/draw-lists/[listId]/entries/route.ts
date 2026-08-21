/**
 * PUT /api/admin/draw-lists/[listId]/entries
 *
 * 抽選リストの中身を**丸ごと入れ替える**。
 * 並べ替え・編集・削除もすべてこれ 1 つで済ませる
 * （1 行ずつの差分 API にすると、同姓同名や並べ替えで壊れやすい）。
 */

import { replaceDrawEntries } from '@/application/services/draw-list-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody } from '@/lib/http/route-helpers';
import { replaceDrawEntriesSchema } from '@/lib/validation/schemas';
import type { DrawListDetailResponse } from '@/types/api';
import { requireUuidParam, withParams } from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { listId: string };

export const PUT = withParams<Params>('admin.draw_lists.replace_entries', async (request, ctx) => {
  assertSameOrigin(request);

  const listId = requireUuidParam(ctx.params.listId, 'listId');
  const input = await parseJsonBody(request, replaceDrawEntriesSchema);
  const list = await replaceDrawEntries(listId, input.entries);

  return jsonOk<DrawListDetailResponse>({ list });
});
