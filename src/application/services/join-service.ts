import 'server-only';

/**
 * 参加（QR コードからの直行）のユースケース。
 *
 * 原則:
 * - 参加は QR の URL 直行のみ。ルームコード入力の導線は作らない。
 * - トークンはログ・エラー・解析へ出さない（redactPath / redactToken を使う）。
 * - ニックネーム重複は DB の UNIQUE 制約が最終判定。アプリ側の事前チェックは体験改善のため。
 * - レスポンスに quiz_snapshot・正解情報・他人のトークンを含めない。
 */

import { ensureAuthSession } from '@/lib/auth/anonymous';
import { AppError } from '@/lib/errors/app-error';
import { logger } from '@/infrastructure/logging/logger';
import { createSupabaseServerClient } from '@/infrastructure/supabase/server';
import { assertRpcOk, throwIfDbError } from '@/infrastructure/supabase/repositories/db-errors';
import { roomRepository } from '@/infrastructure/supabase/repositories/room-repository';
import { parseQuizSnapshot } from '@/application/services/quiz-snapshot-codec';
import { hashToken, isPlausibleToken } from '@/lib/crypto/tokens';
import { verifyCaptchaIfConfigured, isCaptchaConfigured } from '@/lib/http/captcha';
import { checkRateLimit, clientIpFromRequest, clientKeyFromRequest } from '@/lib/http/rate-limit';
import { nicknameSchema, type RegisterParticipantInput } from '@/lib/validation/schemas';
import type { JoinRegisterResponse, JoinResolveResponse } from '@/types/api';
import type { RoomRow } from '@/types/database';
import { getOptionalAuthUser } from '@/lib/auth/session';

/** ニックネーム候補の最大試行数。 */
const NICKNAME_SUGGESTION_LIMIT = 99;

async function resolveRoomOrThrow(token: string): Promise<RoomRow> {
  if (!isPlausibleToken(token)) {
    throw new AppError('JOIN_LINK_INVALID');
  }

  const room = await roomRepository.findRoomByJoinTokenHash(hashToken(token));
  if (!room) {
    // 旧トークンか、そもそも存在しないか区別できない。
    // 会場では「二次元コードを読み直す」誘導が有効なので REVOKED 相当の文言は
    // JOIN_LINK_INVALID とは別に扱わず、404 で統一する。
    throw new AppError('JOIN_LINK_INVALID');
  }

  return room;
}

/** 参加 URL を解決して、ロビー表示に必要な最小限の情報だけ返す。 */
export async function resolveJoinToken(token: string): Promise<JoinResolveResponse> {
  const room = await resolveRoomOrThrow(token);
  const snapshot = parseQuizSnapshot(room.quiz_snapshot);
  const participantCount = await roomRepository.countParticipants(room.id);

  let alreadyJoinedNickname: string | null = null;
  const user = await getOptionalAuthUser();
  if (user) {
    const member = await roomRepository.getMember(room.id, user.id);
    if (member && member.role === 'participant') {
      alreadyJoinedNickname = member.nickname;
    }
  }

  return {
    roomId: room.id,
    quizTitle: snapshot.title,
    joinOpen: room.join_open && room.phase !== 'finished',
    participantCount,
    maxParticipants: room.max_participants,
    alreadyJoinedNickname,
    captchaRequired: isCaptchaConfigured(),
  };
}

/**
 * 参加者を登録する。
 *
 * 一意性は DB の room_members(room_id, lower(nickname)) UNIQUE 制約が最終判定。
 * ここでのレート制限はインスタンスローカルのベストエフォート。
 */
export async function registerParticipant(
  token: string,
  input: RegisterParticipantInput,
  request: Request,
): Promise<JoinRegisterResponse> {
  checkRateLimit(clientKeyFromRequest(request, 'join-register'), {
    limit: 10,
    windowMs: 60_000,
  });

  const room = await resolveRoomOrThrow(token);

  // トークン単位でも制限し、1 つの QR への総当たりを抑える。
  checkRateLimit(`join-register-room:${room.id}`, { limit: 600, windowMs: 60_000 });

  if (room.phase === 'finished') {
    throw new AppError('ROOM_FINISHED');
  }
  if (!room.join_open) {
    throw new AppError('JOIN_CLOSED');
  }

  await verifyCaptchaIfConfigured(input.captchaToken, clientIpFromRequest(request));

  const parsedNickname = nicknameSchema.safeParse(input.nickname);
  if (!parsedNickname.success) {
    throw new AppError('NICKNAME_INVALID');
  }
  const nickname = parsedNickname.data;

  const user = await ensureAuthSession();

  // 再訪（同じ端末・同じ匿名ユーザー）なら既存の参加者情報を返す。
  const existing = await roomRepository.getMember(room.id, user.id);
  if (existing && existing.role === 'participant') {
    return {
      roomId: room.id,
      participantId: existing.id,
      nickname: existing.nickname ?? nickname,
    };
  }

  const participantCount = await roomRepository.countParticipants(room.id);
  if (participantCount >= room.max_participants) {
    throw new AppError('ROOM_FULL');
  }

  // 参加者行の作成は DB 側 RPC が担当する（auth.uid() を参照するため利用者スコープで呼ぶ）。
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('register_participant', {
    p_room_id: room.id,
    p_nickname: nickname,
  });

  throwIfDbError(error, { '23505': 'NICKNAME_TAKEN' });
  assertRpcOk(data);

  const member = await roomRepository.getMember(room.id, user.id);
  if (!member) {
    throw new AppError('INTERNAL_ERROR');
  }

  logger.info('join.registered', { roomId: room.id, participantId: member.id });

  return {
    roomId: room.id,
    participantId: member.id,
    nickname: member.nickname ?? nickname,
  };
}

/**
 * 重複しないニックネーム候補を返す（例: 「木村」→「木村2」）。
 * 完全な一意性は DB が担保するため、ここでは候補提示に留める。
 */
export async function suggestNickname(roomId: string, base: string): Promise<string> {
  const parsed = nicknameSchema.safeParse(base);
  const seed = parsed.success ? parsed.data : '参加者';

  const members = await roomRepository.getRoomMembers(roomId, 'participant');
  const taken = new Set(
    members
      .map((member) => member.nickname)
      .filter((nickname): nickname is string => typeof nickname === 'string')
      .map((nickname) => nickname.toLowerCase()),
  );

  if (!taken.has(seed.toLowerCase())) {
    return seed;
  }

  for (let suffix = 2; suffix <= NICKNAME_SUGGESTION_LIMIT; suffix += 1) {
    const suffixText = String(suffix);
    // 20 文字上限を超えないよう、必要なら前方を切り詰める。
    const head = seed.slice(0, Math.max(1, 20 - suffixText.length));
    const candidate = `${head}${suffixText}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  // ここまで埋まっているのは実質ありえないが、最後の手段として乱数を付ける。
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `${seed.slice(0, 16)}${random}`;
}
