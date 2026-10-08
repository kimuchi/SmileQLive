/**
 * 投票の送信（参加者のみ）。
 *
 * - **1 端末につき 1 票。** 二度目は `ALREADY_VOTED` を返す。
 *   判定は Firestore の `create`（ドキュメント ID が参加者 ID）に任せる。
 *   「読んでから書く」にすると、同時に 2 回送られたとき両方が通りうる。
 * - **票数も順位も返さない。** 返すのは受け付けた事実と自分が入れた中身だけ。
 *   途中経過が見えると、あとの人の投票が引っぱられる。
 */

import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { submitVote } from '@/application/services/poll-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute, parseJsonBody } from '@/lib/http/route-helpers';
import { submitVoteSchema } from '@/lib/validation/schemas';
import type { SubmitVoteResponse } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ roomId: string }>('rooms.vote', async (request, ctx) => {
  assertSameOrigin(request);
  const roomId = requireRoomId(ctx.params);
  const input = await parseJsonBody(request, submitVoteSchema);
  const result = await submitVote(roomId, input.choices);

  const body: SubmitVoteResponse = { accepted: true, choices: result.choices };
  return jsonOk(body);
});
