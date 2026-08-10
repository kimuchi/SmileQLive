import { Timestamp } from 'firebase-admin/firestore';
import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { memberRef } from '@/infrastructure/firebase/paths';
import { logger } from '@/infrastructure/logging/logger';
import { requireParticipant } from '@/lib/auth/session';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute } from '@/lib/http/route-helpers';

/**
 * 参加者の離脱（自分自身のみ）。
 *
 * - ドキュメントは削除せず isActive = false にする。
 *   削除すると回答（answers.participantId）との対応が失われ、集計・順位が壊れるため。
 * - ニックネームも保持し、同じ端末が戻ってきたときに同一参加者として扱えるようにする。
 * - 冪等。すでに離脱済みでも 200 を返す。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ roomId: string }>('rooms.leave', async (request, ctx) => {
  assertSameOrigin(request);
  const roomId = requireRoomId(ctx.params);
  const { member } = await requireParticipant(roomId);

  await memberRef(roomId, member.id).update({
    isActive: false,
    lastSeenAt: Timestamp.now(),
  });

  logger.info('room.participant_left', { roomId, participantId: member.id });

  return jsonOk({ left: true });
});
