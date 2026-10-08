/**
 * 締め切ったあとの集計を直す／数え直す（司会のみ）。
 *
 * PATCH … 司会が入れ直した票数で置き換える。
 *          紙の投票と合わせたり、明らかな異常値を外したりするための操作。
 * POST  … 投票の記録から作り直す（直しすぎたときの戻し口）。
 *
 * **受け取るのは票数だけ。** 点数はサーバーが票数から計算し直す。
 * 点数を直接受け取ると、票数と食い違ったまま発表されうる。
 * 直せるのは締切後・発表前だけ。会場へ出した数字が後から変わると混乱する。
 */

import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { editPollTally, recountPollTally } from '@/application/services/poll-service';
import { getStaffSnapshot } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute, parseJsonBody } from '@/lib/http/route-helpers';
import { editPollTallySchema } from '@/lib/validation/schemas';
import type { PollTallyResponse } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 直したあとの表を司会へ返す。順位の付け直しはサーバーの仕事。 */
async function tallyResponse(roomId: string, voterCount: number): Promise<PollTallyResponse> {
  const snapshot = await getStaffSnapshot(roomId, 'host');
  return { rows: snapshot.pollTally ?? [], voterCount };
}

export const PATCH = defineRoute<{ roomId: string }>('rooms.poll_tally.edit', async (request, ctx) => {
  assertSameOrigin(request);
  const roomId = requireRoomId(ctx.params);
  const input = await parseJsonBody(request, editPollTallySchema);
  const tally = await editPollTally(roomId, input.entries, input.voterCount);

  return jsonOk<PollTallyResponse>(await tallyResponse(roomId, tally.voterCount));
});

export const POST = defineRoute<{ roomId: string }>('rooms.poll_tally.recount', async (request, ctx) => {
  assertSameOrigin(request);
  const roomId = requireRoomId(ctx.params);
  const tally = await recountPollTally(roomId);

  return jsonOk<PollTallyResponse>(await tallyResponse(roomId, tally.voterCount));
});
