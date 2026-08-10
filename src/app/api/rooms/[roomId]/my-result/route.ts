import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { getMyResult } from '@/application/services/answer-service';
import { jsonOk } from '@/lib/errors/api-response';
import { defineRoute } from '@/lib/http/route-helpers';
import type { MyResultResponse } from '@/types/api';

/**
 * 参加者自身の結果。
 * 正解発表前は isCorrect / pointsAwarded を null で返す（サービス層で制御）。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = defineRoute<{ roomId: string }>('rooms.my_result', async (_request, ctx) => {
  const roomId = requireRoomId(ctx.params);
  const result = await getMyResult(roomId);
  return jsonOk<MyResultResponse>(result);
});
