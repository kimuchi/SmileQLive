import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { getParticipantSnapshot } from '@/application/services/room-service';
import { jsonOk } from '@/lib/errors/api-response';
import { defineRoute } from '@/lib/http/route-helpers';
import type { ParticipantSnapshotResponse } from '@/types/api';

/**
 * 参加者画面の Snapshot。
 *
 * - quiz_snapshot 全体・他参加者の回答・参加トークンは含めない。
 * - 正解情報は正解発表フェーズ以降だけ含まれる（サービス層の toPublicQuestion / reveal 判定）。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = defineRoute<{ roomId: string }>(
  'rooms.participant_snapshot',
  async (_request, ctx) => {
    const roomId = requireRoomId(ctx.params);
    const snapshot = await getParticipantSnapshot(roomId);
    return jsonOk<ParticipantSnapshotResponse>({ snapshot });
  },
);
