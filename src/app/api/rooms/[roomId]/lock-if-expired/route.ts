import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { lockQuestionIfExpired } from '@/application/services/room-service';
import { requireRoomMember } from '@/lib/auth/session';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute } from '@/lib/http/route-helpers';
import { checkRateLimit, clientKeyFromRequest } from '@/lib/http/rate-limit';
import type { RoomActionResponse } from '@/types/api';

/**
 * 締切時刻を過ぎた問題を締め切る（投影・司会から呼べる冪等な操作）。
 *
 * - 判定に使うのは DB に保存された answer_deadline_at とサーバー時刻のみ。
 *   クライアントが送る時刻は受け取らない。
 * - すでに締切済み・まだ締切前なら遷移せず、現在状態を 200 で返す。
 *   投影画面のカウントダウン終了時に何度呼ばれても安全にする。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ roomId: string }>(
  'rooms.lock_if_expired',
  async (request, ctx) => {
    assertSameOrigin(request);
    const roomId = requireRoomId(ctx.params);

    // 投影・司会の端末は多くても数台。会場 Wi-Fi の共有 IP でも詰まらない上限にする。
    checkRateLimit(clientKeyFromRequest(request, 'lock-if-expired'), {
      limit: 300,
      windowMs: 60_000,
    });

    const locked = await lockQuestionIfExpired(roomId);
    if (locked) {
      return jsonOk<RoomActionResponse>(locked);
    }

    // 遷移しなかった場合も現在状態を返す（呼び出し側が Snapshot を取り直す必要はない）。
    const { room } = await requireRoomMember(roomId, ['host', 'presenter']);
    return jsonOk<RoomActionResponse>({
      phase: room.phase,
      stateVersion: room.state_version,
      serverTime: new Date().toISOString(),
    });
  },
);
