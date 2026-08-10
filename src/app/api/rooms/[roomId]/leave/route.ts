import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { createSupabaseAdminClient } from '@/infrastructure/supabase/admin';
import { throwIfDbError } from '@/infrastructure/supabase/repositories/db-errors';
import { logger } from '@/infrastructure/logging/logger';
import { requireParticipant } from '@/lib/auth/session';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute } from '@/lib/http/route-helpers';

/**
 * 参加者の離脱（自分自身のみ）。
 *
 * - 行は削除せず is_active = false にする。
 *   削除すると回答（answers.participant_id）が連鎖削除され、集計・順位が壊れるため。
 * - ニックネームも保持し、同じ端末が戻ってきたときに同一参加者として扱えるようにする。
 * - 冪等。すでに離脱済みでも 200 を返す。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ roomId: string }>('rooms.leave', async (request, ctx) => {
  assertSameOrigin(request);
  const roomId = requireRoomId(ctx.params);
  const { member } = await requireParticipant(roomId);

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from('room_members')
    .update({ is_active: false, last_seen_at: new Date().toISOString() })
    .eq('id', member.id);
  throwIfDbError(error);

  logger.info('room.participant_left', { roomId, participantId: member.id });

  return jsonOk({ left: true });
});
