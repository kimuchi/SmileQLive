import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { setJoinOpen } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute } from '@/lib/http/route-helpers';

/**
 * 参加受付を締め切る（司会のみ）。
 * 既に締切済みでも成功として扱う（冪等）。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ roomId: string }>('rooms.close_join', async (request, ctx) => {
  assertSameOrigin(request);
  const roomId = requireRoomId(ctx.params);
  await setJoinOpen(roomId, false);
  return jsonOk({ joinOpen: false });
});
