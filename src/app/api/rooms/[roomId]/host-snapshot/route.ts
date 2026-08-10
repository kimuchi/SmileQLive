import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { getStaffSnapshot } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { defineRoute } from '@/lib/http/route-helpers';
import type { HostSnapshotResponse } from '@/types/api';

/**
 * 司会画面の Snapshot。
 * 正解情報・集計はフェーズ条件を満たすときだけサービス層が含める。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = defineRoute<{ roomId: string }>('rooms.host_snapshot', async (_request, ctx) => {
  const roomId = requireRoomId(ctx.params);
  const snapshot = await getStaffSnapshot(roomId, 'host');
  return jsonOk<HostSnapshotResponse>({ snapshot });
});
