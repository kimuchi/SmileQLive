import { z } from 'zod';
import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { getLeaderboard } from '@/application/services/answer-service';
import { jsonOk } from '@/lib/errors/api-response';
import { defineRoute, parseSearchParams } from '@/lib/http/route-helpers';
import type { LeaderboardResponse } from '@/types/api';

/**
 * ランキング。
 *
 * 参加者も呼べるが、正解発表前・ランキング非表示設定なら空配列になる
 * （判定はサービス層。ここでフェーズ判定を持たない）。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  // クエリ文字列は常に string なので、数値へ変換してから範囲を検証する。
  limit: z
    .string()
    .regex(/^[0-9]{1,4}$/, '表示件数の指定が正しくありません')
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.int().min(1).max(1000))
    .optional(),
});

export const GET = defineRoute<{ roomId: string }>('rooms.leaderboard', async (request, ctx) => {
  const roomId = requireRoomId(ctx.params);
  const { limit } = parseSearchParams(request, querySchema);
  const leaderboard = await getLeaderboard(roomId, limit);
  return jsonOk<LeaderboardResponse>({ leaderboard });
});
