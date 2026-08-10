import 'server-only';

/**
 * 認証・認可のサーバー専用ヘルパー。
 *
 * 方針:
 * - 認証状態は必ず Auth Cookie 連携クライアント (`createSupabaseServerClient`) の
 *   `auth.getUser()` から取得する。クライアントから送られた userId / role は信用しない。
 * - 所有権・役割の照合は管理クライアント（RLS 迂回）で行うが、
 *   照合結果が合致しない限り必ず AppError を投げる。
 * - 匿名ユーザー（参加者）は profiles を持たないため、管理系操作は requireHostUser で弾く。
 */

import type { User } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '@/infrastructure/supabase/admin';
import { createSupabaseServerClient } from '@/infrastructure/supabase/server';
import { AppError } from '@/lib/errors/app-error';
import type {
  ChoiceRow,
  QuestionRow,
  QuizRow,
  RoomMemberRole,
  RoomMemberRow,
  RoomRow,
} from '@/types/database';

/** 認証済みなら User、未認証なら null。 */
export async function getOptionalAuthUser(): Promise<User | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return null;
  }
  return data.user;
}

/** 認証必須。匿名セッションも「認証済み」として扱う（参加者導線で使う）。 */
export async function requireAuthUser(): Promise<User> {
  const user = await getOptionalAuthUser();
  if (!user) {
    throw new AppError('UNAUTHENTICATED');
  }
  return user;
}

/**
 * 管理・司会向け。profiles に行がある（＝招待された非匿名ユーザー）ことを要求する。
 */
export async function requireHostUser(): Promise<{ user: User; profileId: string }> {
  const user = await requireAuthUser();

  if (user.is_anonymous === true) {
    throw new AppError('FORBIDDEN');
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from('profiles').select('id').eq('id', user.id).maybeSingle();

  if (error) {
    throw new AppError('INTERNAL_ERROR', { cause: error });
  }
  if (!data) {
    throw new AppError('FORBIDDEN');
  }

  return { user, profileId: data.id };
}

/** クイズの所有者であることを要求する。 */
export async function requireQuizOwner(quizId: string): Promise<{ user: User; quiz: QuizRow }> {
  const { user } = await requireHostUser();
  const admin = createSupabaseAdminClient();

  const { data, error } = await admin.from('quizzes').select('*').eq('id', quizId).maybeSingle();
  if (error) {
    throw new AppError('INTERNAL_ERROR', { cause: error });
  }
  if (!data) {
    throw new AppError('QUIZ_NOT_FOUND');
  }
  if (data.owner_id !== user.id) {
    // 他人のクイズの存在有無を漏らさないため、404 ではなく 403 で統一する。
    throw new AppError('FORBIDDEN');
  }

  return { user, quiz: data };
}

/** 問題の所有者（＝親クイズの所有者）であることを要求する。 */
export async function requireQuestionOwner(
  questionId: string,
): Promise<{ user: User; question: QuestionRow; quiz: QuizRow }> {
  const { user } = await requireHostUser();
  const admin = createSupabaseAdminClient();

  const { data: question, error } = await admin
    .from('questions')
    .select('*')
    .eq('id', questionId)
    .maybeSingle();
  if (error) {
    throw new AppError('INTERNAL_ERROR', { cause: error });
  }
  if (!question) {
    throw new AppError('QUESTION_NOT_FOUND');
  }

  const { data: quiz, error: quizError } = await admin
    .from('quizzes')
    .select('*')
    .eq('id', question.quiz_id)
    .maybeSingle();
  if (quizError) {
    throw new AppError('INTERNAL_ERROR', { cause: quizError });
  }
  if (!quiz) {
    throw new AppError('QUIZ_NOT_FOUND');
  }
  if (quiz.owner_id !== user.id) {
    throw new AppError('FORBIDDEN');
  }

  return { user, question, quiz };
}

/** 選択肢の所有者であることを要求する。 */
export async function requireChoiceOwner(
  choiceId: string,
): Promise<{ user: User; choice: ChoiceRow; question: QuestionRow; quiz: QuizRow }> {
  const { user } = await requireHostUser();
  const admin = createSupabaseAdminClient();

  const { data: choice, error } = await admin
    .from('choices')
    .select('*')
    .eq('id', choiceId)
    .maybeSingle();
  if (error) {
    throw new AppError('INTERNAL_ERROR', { cause: error });
  }
  if (!choice) {
    throw new AppError('QUESTION_NOT_FOUND');
  }

  const { data: question, error: questionError } = await admin
    .from('questions')
    .select('*')
    .eq('id', choice.question_id)
    .maybeSingle();
  if (questionError) {
    throw new AppError('INTERNAL_ERROR', { cause: questionError });
  }
  if (!question) {
    throw new AppError('QUESTION_NOT_FOUND');
  }

  const { data: quiz, error: quizError } = await admin
    .from('quizzes')
    .select('*')
    .eq('id', question.quiz_id)
    .maybeSingle();
  if (quizError) {
    throw new AppError('INTERNAL_ERROR', { cause: quizError });
  }
  if (!quiz) {
    throw new AppError('QUIZ_NOT_FOUND');
  }
  if (quiz.owner_id !== user.id) {
    throw new AppError('FORBIDDEN');
  }

  return { user, choice, question, quiz };
}

/** ルームの所有者であることを要求する。 */
export async function requireRoomOwner(roomId: string): Promise<{ user: User; room: RoomRow }> {
  const { user } = await requireHostUser();
  const room = await fetchRoom(roomId);

  if (room.owner_id !== user.id) {
    throw new AppError('FORBIDDEN');
  }

  return { user, room };
}

/**
 * ルームメンバーであり、かつ指定した役割のいずれかであることを要求する。
 * 参加者だけを許可する場合は requireParticipant を使う。
 */
export async function requireRoomMember(
  roomId: string,
  roles: RoomMemberRole[],
): Promise<{ user: User; member: RoomMemberRow; room: RoomRow }> {
  const user = await requireAuthUser();
  const room = await fetchRoom(roomId);
  const admin = createSupabaseAdminClient();

  const { data: member, error } = await admin
    .from('room_members')
    .select('*')
    .eq('room_id', roomId)
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (error) {
    throw new AppError('INTERNAL_ERROR', { cause: error });
  }

  if (!member || !roles.includes(member.role)) {
    // ルーム所有者は host メンバー行が無くても host として扱う（作成直後の復旧用）。
    if (roles.includes('host') && room.owner_id === user.id) {
      const restored = await ensureHostMember(roomId, user.id);
      return { user, member: restored, room };
    }
    throw new AppError(roles.includes('participant') ? 'NOT_A_PARTICIPANT' : 'FORBIDDEN');
  }

  return { user, member, room };
}

/** 参加者であることを要求する。 */
export async function requireParticipant(
  roomId: string,
): Promise<{ user: User; member: RoomMemberRow; room: RoomRow }> {
  return requireRoomMember(roomId, ['participant']);
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

async function fetchRoom(roomId: string): Promise<RoomRow> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from('rooms').select('*').eq('id', roomId).maybeSingle();
  if (error) {
    throw new AppError('INTERNAL_ERROR', { cause: error });
  }
  if (!data) {
    throw new AppError('ROOM_NOT_FOUND');
  }
  return data;
}

async function ensureHostMember(roomId: string, userId: string): Promise<RoomMemberRow> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('room_members')
    .upsert(
      { room_id: roomId, auth_user_id: userId, role: 'host', nickname: null },
      { onConflict: 'room_id,auth_user_id' },
    )
    .select('*')
    .single();

  if (error || !data) {
    throw new AppError('FORBIDDEN', { cause: error });
  }
  return data;
}
