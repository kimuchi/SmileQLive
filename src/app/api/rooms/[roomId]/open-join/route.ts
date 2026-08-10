import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { setJoinOpen } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute } from '@/lib/http/route-helpers';

/**
 * 参加受付を再開する（司会のみ）。
 * 既に受付中でも成功として扱う（冪等）。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ roomId: string }>('rooms.open_join', async (request, ctx) => {
  assertSameOrigin(request);
  const roomId = requireRoomId(ctx.params);
  await setJoinOpen(roomId, true);
  return jsonOk({ joinOpen: true });
});
