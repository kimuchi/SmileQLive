import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { getStaffSnapshot } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { defineRoute } from '@/lib/http/route-helpers';
import type { StaffSnapshotResponse } from '@/types/api';

/**
 * 投影画面の Snapshot（presenter または host）。
 *
 * - 参照専用。ここから進行を変更する手段は用意しない。
 * - 投影担当には参加 URL・参加者一覧を返さない（サービス層で除外済み）。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = defineRoute<{ roomId: string }>(
  'rooms.staff_snapshot',
  async (_request, ctx) => {
    const roomId = requireRoomId(ctx.params);
    const snapshot = await getStaffSnapshot(roomId, 'presenter');
    return jsonOk<StaffSnapshotResponse>({ snapshot });
  },
);
