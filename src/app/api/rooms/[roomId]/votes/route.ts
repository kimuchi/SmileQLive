/**
 * 投票をすべて捨てる（司会のみ）。
 *
 * 練習で入れた票を消してから本番を始めるための操作。
 * 受付中か締切後にだけ許す（発表を始めたあとに消しても意味が無い）。
 * 凍らせた集計も一緒に捨てる。片方だけ残ると数字が食い違う。
 */

import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { clearPollVotes } from '@/application/services/poll-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute } from '@/lib/http/route-helpers';
import type { PollVotesClearedResponse } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = defineRoute<{ roomId: string }>('rooms.votes.clear', async (request, ctx) => {
  assertSameOrigin(request);
  const roomId = requireRoomId(ctx.params);
  const cleared = await clearPollVotes(roomId);

  return jsonOk<PollVotesClearedResponse>({ cleared });
});
