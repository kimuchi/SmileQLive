import 'server-only';

/**
 * ルーム・メンバー・投影リンクの永続化。
 *
 * 方針:
 * - ルームの進行状態は DB だけが持つ。インスタンスメモリへキャッシュしない。
 * - 状態遷移は DB の `transition_room` RPC が state_version を検証しながら行う。
 *   RPC は認可のため `auth.uid()` を参照するので、**利用者スコープのクライアント**で呼ぶ。
 * - RPC の戻り値形式に依存しないよう、更新後は必ず rooms を読み直して確定値を返す。
 * - 期限判定 (投影リンク) は `now()` を DB 側で評価させる。クライアント時刻を使わない。
 */

import { createSupabaseAdminClient } from '@/infrastructure/supabase/admin';
import { createSupabaseServerClient } from '@/infrastructure/supabase/server';
import { assertRpcOk, throwIfDbError } from '@/infrastructure/supabase/repositories/db-errors';
import { isRecord } from '@/infrastructure/supabase/repositories/row-utils';
import { AppError } from '@/lib/errors/app-error';
import type {
  CreatePresentationLinkInput,
  CreateRoomDbInput,
  RoomRepository,
  TransitionRoomDbInput,
} from '@/application/ports/room-repository-port';
import type { RoomListItem } from '@/types/api';
import type {
  Json,
  PresentationLinkRow,
  RoomMemberRole,
  RoomMemberRow,
  RoomRow,
} from '@/types/database';

function snapshotTitle(snapshot: Json): string {
  if (isRecord(snapshot) && typeof snapshot.title === 'string') {
    return snapshot.title;
  }
  return '無題のクイズ';
}

export async function createRoom(input: CreateRoomDbInput): Promise<RoomRow> {
  const admin = createSupabaseAdminClient();

  const { data, error } = await admin
    .from('rooms')
    .insert({
      owner_id: input.ownerId,
      quiz_id: input.quizId,
      join_token_hash: input.joinTokenHash,
      quiz_snapshot: input.quizSnapshot as unknown as Json,
      max_participants: input.maxParticipants,
      phase: 'lobby',
      join_open: true,
      state_version: 0,
    })
    .select('*')
    .single();

  throwIfDbError(error);
  if (!data) {
    throw new AppError('INTERNAL_ERROR');
  }

  // 司会者のメンバー行を作る。失敗したらルームごと戻す（孤立ルームを残さない）。
  const { error: memberError } = await admin.from('room_members').insert({
    room_id: data.id,
    auth_user_id: input.ownerId,
    role: 'host',
    nickname: null,
  });

  if (memberError) {
    await admin.from('rooms').delete().eq('id', data.id);
    throwIfDbError(memberError);
  }

  return data;
}

export async function getRoom(roomId: string): Promise<RoomRow | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from('rooms').select('*').eq('id', roomId).maybeSingle();
  throwIfDbError(error);
  return data ?? null;
}

export async function requireRoom(roomId: string): Promise<RoomRow> {
  const room = await getRoom(roomId);
  if (!room) {
    throw new AppError('ROOM_NOT_FOUND');
  }
  return room;
}

export async function findRoomByJoinTokenHash(tokenHash: string): Promise<RoomRow | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('rooms')
    .select('*')
    .eq('join_token_hash', tokenHash)
    .maybeSingle();
  throwIfDbError(error);
  return data ?? null;
}

export async function rotateJoinToken(
  roomId: string,
  tokenHash: string,
): Promise<{ rotatedAt: string }> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('rooms')
    .update({ join_token_hash: tokenHash, join_token_rotated_at: new Date().toISOString() })
    .eq('id', roomId)
    .select('join_token_rotated_at')
    .single();

  throwIfDbError(error);
  if (!data) {
    throw new AppError('ROOM_NOT_FOUND');
  }
  return { rotatedAt: data.join_token_rotated_at };
}

export async function setJoinOpen(roomId: string, open: boolean): Promise<void> {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('rooms').update({ join_open: open }).eq('id', roomId);
  throwIfDbError(error);
}

export async function listRooms(ownerId: string): Promise<RoomListItem[]> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('rooms')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(100);

  throwIfDbError(error);
  const rooms = data ?? [];
  if (rooms.length === 0) {
    return [];
  }

  const { data: members, error: memberError } = await admin
    .from('room_members')
    .select('room_id')
    .eq('role', 'participant')
    .in(
      'room_id',
      rooms.map((room) => room.id),
    );
  throwIfDbError(memberError);

  const counts = new Map<string, number>();
  for (const member of members ?? []) {
    counts.set(member.room_id, (counts.get(member.room_id) ?? 0) + 1);
  }

  return rooms.map((room) => ({
    id: room.id,
    quizTitle: snapshotTitle(room.quiz_snapshot),
    phase: room.phase,
    participantCount: counts.get(room.id) ?? 0,
    createdAt: room.created_at,
    finishedAt: room.finished_at,
  }));
}

export async function getRoomMembers(
  roomId: string,
  role?: RoomMemberRole,
): Promise<RoomMemberRow[]> {
  const admin = createSupabaseAdminClient();
  let query = admin.from('room_members').select('*').eq('room_id', roomId);
  if (role) {
    query = query.eq('role', role);
  }
  const { data, error } = await query.order('joined_at', { ascending: true });
  throwIfDbError(error);
  return data ?? [];
}

export async function getMember(
  roomId: string,
  authUserId: string,
): Promise<RoomMemberRow | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('room_members')
    .select('*')
    .eq('room_id', roomId)
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  throwIfDbError(error);
  return data ?? null;
}

export async function upsertStaffMember(
  roomId: string,
  authUserId: string,
  role: Extract<RoomMemberRole, 'host' | 'presenter'>,
): Promise<RoomMemberRow> {
  const admin = createSupabaseAdminClient();
  const existing = await getMember(roomId, authUserId);

  // すでに参加者・司会として登録済みなら降格させない。
  if (existing && existing.role !== role) {
    if (existing.role === 'host' || existing.role === 'participant') {
      return existing;
    }
  }

  const { data, error } = await admin
    .from('room_members')
    .upsert(
      { room_id: roomId, auth_user_id: authUserId, role, nickname: null },
      { onConflict: 'room_id,auth_user_id' },
    )
    .select('*')
    .single();

  throwIfDbError(error);
  if (!data) {
    throw new AppError('INTERNAL_ERROR');
  }
  return data;
}

export async function countParticipants(roomId: string): Promise<number> {
  const admin = createSupabaseAdminClient();
  const { count, error } = await admin
    .from('room_members')
    .select('id', { count: 'exact', head: true })
    .eq('room_id', roomId)
    .eq('role', 'participant');
  throwIfDbError(error);
  return count ?? 0;
}

export async function countActiveParticipants(roomId: string): Promise<number> {
  const admin = createSupabaseAdminClient();
  const { count, error } = await admin
    .from('room_members')
    .select('id', { count: 'exact', head: true })
    .eq('room_id', roomId)
    .eq('role', 'participant')
    .eq('is_active', true);
  throwIfDbError(error);
  return count ?? 0;
}

export async function countAnswers(roomId: string, questionId: string): Promise<number> {
  const admin = createSupabaseAdminClient();
  const { count, error } = await admin
    .from('answers')
    .select('id', { count: 'exact', head: true })
    .eq('room_id', roomId)
    .eq('question_id', questionId);
  throwIfDbError(error);
  return count ?? 0;
}

export async function touchMemberPresence(memberId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from('room_members')
    .update({ last_seen_at: new Date().toISOString(), is_active: true })
    .eq('id', memberId);
  // presence の更新失敗は進行を妨げない。
  if (error) {
    return;
  }
}

// ---------------------------------------------------------------------------
// 投影リンク
// ---------------------------------------------------------------------------

export async function createPresentationLink(
  input: CreatePresentationLinkInput,
): Promise<PresentationLinkRow> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('presentation_links')
    .insert({
      room_id: input.roomId,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
      created_by: input.createdBy,
    })
    .select('*')
    .single();

  throwIfDbError(error);
  if (!data) {
    throw new AppError('INTERNAL_ERROR');
  }
  return data;
}

/**
 * 投影リンクを引き当てる。
 * 期限判定は `now()` を DB 側で評価させ、Cloud Run 側の時計に依存させない。
 * 一度使ったリンクも期限内なら再読込できる（consumed_at は初回利用時刻の記録）。
 */
export async function consumePresentationLink(tokenHash: string): Promise<PresentationLinkRow> {
  const admin = createSupabaseAdminClient();

  const { data: link, error } = await admin
    .from('presentation_links')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  throwIfDbError(error);
  if (!link) {
    throw new AppError('PRESENTATION_LINK_INVALID');
  }

  const { data: valid, error: validError } = await admin
    .from('presentation_links')
    .select('id')
    .eq('id', link.id)
    .gt('expires_at', 'now()')
    .maybeSingle();
  throwIfDbError(validError);
  if (!valid) {
    throw new AppError('PRESENTATION_LINK_EXPIRED');
  }

  if (!link.consumed_at) {
    const { error: consumeError } = await admin
      .from('presentation_links')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', link.id)
      .is('consumed_at', null);
    throwIfDbError(consumeError);
  }

  return link;
}

// ---------------------------------------------------------------------------
// 状態遷移
// ---------------------------------------------------------------------------

/**
 * DB の transition_room を呼ぶ。
 * - state_version の検証・締切時刻の設定は DB 側で行う（DB 時刻が唯一の正）。
 * - 認可のため auth.uid() が必要なので利用者スコープのクライアントで呼ぶ。
 * - 戻り値の JSON 形式へ依存しないよう、成功後に rooms を読み直す。
 */
export async function transitionRoom(input: TransitionRoomDbInput): Promise<RoomRow> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('transition_room', {
    p_room_id: input.roomId,
    p_action: input.action,
    p_expected_version: input.expectedVersion,
    p_question_id: input.questionId ?? null,
  });

  throwIfDbError(error, { '23505': 'STATE_VERSION_CONFLICT' });
  assertRpcOk(data);

  return requireRoom(input.roomId);
}

export const roomRepository: RoomRepository = {
  createRoom,
  getRoom,
  findRoomByJoinTokenHash,
  rotateJoinToken,
  setJoinOpen,
  listRooms,
  getRoomMembers,
  getMember,
  upsertStaffMember,
  countParticipants,
  countAnswers,
  createPresentationLink,
  consumePresentationLink,
  transitionRoom,
  touchMemberPresence,
};
