import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { rotateJoinToken } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute } from '@/lib/http/route-helpers';
import type { RotateJoinTokenResponse } from '@/types/api';

/**
 * 参加 URL の再発行（ルーム所有者のみ）。
 *
 * - 旧トークンはこの時点で失効する。会場では二次元コードを貼り替える運用。
 * - 平文トークンはこのレスポンスでしか返らない。ログ・Referer へ出さない。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ roomId: string }>(
  'rooms.join_token_rotate',
  async (request, ctx) => {
    assertSameOrigin(request);
    const roomId = requireRoomId(ctx.params);
    const rotated = await rotateJoinToken(roomId);
    return jsonOk<RotateJoinTokenResponse>(rotated);
  },
);
