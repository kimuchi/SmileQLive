import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { setDrawHistoryOpen } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute } from '@/lib/http/route-helpers';

/**
 * 投影画面の「出たもの一覧」を出し入れする（司会のみ）。
 *
 * 進行そのものは動かさない。見せ方だけを変える。
 * 同じ値を送っても成功として扱う（冪等）。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ roomId: string }>('rooms.draw_history', async (request, ctx) => {
  assertSameOrigin(request);
  const roomId = requireRoomId(ctx.params);

  const body: unknown = await request.json().catch(() => null);
  const open =
    typeof body === 'object' && body !== null && (body as { open?: unknown }).open === true;

  await setDrawHistoryOpen(roomId, open);
  return jsonOk({ showDrawHistory: open });
});
