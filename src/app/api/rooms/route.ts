import { createRoom } from '@/application/services/room-service';
import { jsonCreated } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody, withRoute } from '@/lib/http/route-helpers';
import { createRoomSchema } from '@/lib/validation/schemas';
import type { CreateRoomResponse } from '@/types/api';

/**
 * ルームの作成（司会専用）。
 *
 * - 認可はサービス層の requireQuizOwner が行う（公開済みクイズのみルーム化できる）。
 * - 平文の参加トークンはこのレスポンスでのみ返す（DB にはハッシュのみ）。
 *   中間キャッシュへ残さないよう no-store を付ける（jsonCreated が付与）。
 * - ルーム一覧は GET /api/admin/rooms（管理側）が担当する。ここでは重複させない。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = withRoute<CreateRoomResponse>('rooms.create', async ({ request }) => {
  assertSameOrigin(request);
  const input = await parseJsonBody(request, createRoomSchema);
  const created = await createRoom(input);
  return jsonCreated<CreateRoomResponse>(created);
});
