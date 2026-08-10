/**
 * GET /api/admin/rooms  自分が司会するルームの一覧
 *
 * 参加トークンは返さない（平文トークンはルーム作成・再発行の応答でのみ返す）。
 */

import { listRooms } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { withRoute } from '@/lib/http/route-helpers';
import type { RoomListItem } from '@/types/api';

export const dynamic = 'force-dynamic';

type RoomListResponse = { rooms: RoomListItem[] };

export const GET = withRoute<RoomListResponse>('admin.rooms.list', async () => {
  const rooms = await listRooms();
  return jsonOk<RoomListResponse>({ rooms });
});
