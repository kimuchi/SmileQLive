/**
 * GET /api/admin/rooms  自分が作成したルームの一覧
 *
 * 司会画面（/host/[roomId]）へ戻る導線として使う。
 * ルームを操作できるのは作成した本人だけなので、一覧も自分の分だけを返す。
 *
 * 参加トークンは返さない（平文トークンはルーム作成・再発行の応答でのみ返す）。
 */

import { listRooms } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { withRoute } from '@/lib/http/route-helpers';
import type { RoomListResponse } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = withRoute<RoomListResponse>('admin.rooms.list', async () => {
  const rooms = await listRooms();
  return jsonOk<RoomListResponse>({ rooms });
});
