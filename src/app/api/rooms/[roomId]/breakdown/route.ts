import { z } from 'zod';
import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { getBreakdown } from '@/application/services/answer-service';
import { jsonOk } from '@/lib/errors/api-response';
import { defineRoute, parseSearchParams } from '@/lib/http/route-helpers';
import { uuidSchema } from '@/lib/validation/schemas';
import type { BreakdownResponse } from '@/types/api';

/**
 * 回答集計（司会・投影）。
 *
 * 回答受付中は集計を返さない（サービス層が null を返す）。
 * 参加者はこのルートを呼べない（requireRoomMember で弾かれる）。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({ questionId: uuidSchema });

export const GET = defineRoute<{ roomId: string }>('rooms.breakdown', async (request, ctx) => {
  const roomId = requireRoomId(ctx.params);
  const { questionId } = parseSearchParams(request, querySchema);
  const breakdown = await getBreakdown(roomId, questionId);
  return jsonOk<BreakdownResponse>({ breakdown });
});
