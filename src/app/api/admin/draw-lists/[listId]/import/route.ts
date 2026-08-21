/**
 * POST /api/admin/draw-lists/[listId]/import
 *
 * 表計算ソフトからの貼り付け、または CSV の中身を取り込む。
 *
 * 解釈の結果（何件読めたか・何を飛ばしたか）も返す。
 * 黙って一部を落とすと「登録したのに抽選に出てこない」事故になる。
 */

import { importDrawEntries } from '@/application/services/draw-list-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody } from '@/lib/http/route-helpers';
import { importDrawEntriesSchema } from '@/lib/validation/schemas';
import type { DrawListImportResponse } from '@/types/api';
import { requireUuidParam, withParams } from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { listId: string };

export const POST = withParams<Params>('admin.draw_lists.import', async (request, ctx) => {
  assertSameOrigin(request);

  const listId = requireUuidParam(ctx.params.listId, 'listId');
  const input = await parseJsonBody(request, importDrawEntriesSchema);
  const { list, imported } = await importDrawEntries(listId, input);

  return jsonOk<DrawListImportResponse>({
    list,
    imported: {
      count: imported.rows.length,
      headers: imported.headers,
      labelColumnIndex: imported.labelColumnIndex,
      skippedEmpty: imported.skippedEmpty,
      truncated: imported.truncated,
      shortened: imported.shortened,
      duplicates: imported.duplicates,
    },
  });
});
