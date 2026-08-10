import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { issuePresentationLink } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute } from '@/lib/http/route-helpers';
import type { PresentationLinkResponse } from '@/types/api';

/**
 * 投影用の一時リンクを発行する（ルーム所有者のみ）。
 *
 * 平文トークンはこのレスポンスでしか返らない（DB にはハッシュのみ）。
 * ログにも出さない。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ roomId: string }>(
  'rooms.presentation_link',
  async (request, ctx) => {
    assertSameOrigin(request);
    const roomId = requireRoomId(ctx.params);
    const link = await issuePresentationLink(roomId);
    return jsonOk<PresentationLinkResponse>(link);
  },
);
