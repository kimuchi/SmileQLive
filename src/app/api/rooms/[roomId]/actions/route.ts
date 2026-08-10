import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { transitionRoom } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute, parseJsonBody } from '@/lib/http/route-helpers';
import { roomActionSchema } from '@/lib/validation/schemas';
import type { RoomActionResponse } from '@/types/api';

/**
 * 司会の進行操作。
 *
 * - expectedVersion が現在の state_version と一致しないときは
 *   STATE_VERSION_CONFLICT (409) を返す。クライアントは Snapshot を取り直す。
 * - 締切時刻の決定は DB 側 (`transition_room`) が行う。クライアント時刻は使わない。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ roomId: string }>('rooms.action', async (request, ctx) => {
  assertSameOrigin(request);
  const roomId = requireRoomId(ctx.params);
  const input = await parseJsonBody(request, roomActionSchema);
  const result = await transitionRoom(roomId, input);
  return jsonOk<RoomActionResponse>(result);
});
