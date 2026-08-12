import 'server-only';

/**
 * 参加（QR コードからの直行）のユースケース。
 *
 * 原則:
 * - 参加は QR の URL 直行のみ。ルームコード入力の導線は作らない。
 * - トークンはログ・エラー・解析へ出さない（route-helpers の redactPath が経路を潰す）。
 * - 参加者行の作成・人数上限・ニックネーム重複は
 *   `infrastructure/firebase/transactions.ts` の registerParticipant() が
 *   1 つのトランザクションで判定する。ここで読み書きを個別に並べない。
 * - レスポンスに quizSnapshot・正解情報・他人のトークンを含めない。
 */

import { ensureAuthSession } from '@/lib/auth/anonymous';
import { AppError } from '@/lib/errors/app-error';
import { logger } from '@/infrastructure/logging/logger';
import {
  findRoomByJoinTokenHash,
  getMember,
  getRoomMembers,
} from '@/infrastructure/firebase/repositories/room-repository';
import { registerParticipant as registerParticipantTx } from '@/infrastructure/firebase/transactions';
import { parseQuizSnapshot } from '@/application/services/quiz-snapshot-codec';
import { hashToken, isPlausibleToken } from '@/lib/crypto/tokens';
import { verifyCaptchaIfConfigured, isCaptchaConfigured } from '@/lib/http/captcha';
import { checkRateLimit, clientIpFromRequest, clientKeyFromRequest } from '@/lib/http/rate-limit';
import { nicknameSchema, type RegisterParticipantInput } from '@/lib/validation/schemas';
import { getOptionalAuthUser } from '@/lib/auth/session';
import type { JoinRegisterResponse, JoinResolveResponse } from '@/types/api';
import type { RoomDoc } from '@/types/firestore';

/** ニックネーム候補の最大試行数。 */
const NICKNAME_SUGGESTION_LIMIT = 99;

/**
 * 同じ回線からの参加登録の上限（60 秒あたり）。
 *
 * **会場では全員が同じ Wi-Fi を使う。** 出口の IP アドレスは 1 つなので、
 * ここを小さくすると「11 人目から誰も入れない」という事故になる。
 * 実際、以前は 10 件だったため 500 人規模では成立しなかった。
 *
 * ここでの役割は「1 台の端末による連打を安く弾く」ことに絞り、
 * 総量の抑制はルーム単位の上限（下の joinLimitForRoom）に任せる。
 * なお参加登録は冪等（同じ匿名利用者なら何度送っても増えない）。
 */
const JOIN_REGISTER_PER_CLIENT_LIMIT = 300;

/**
 * 1 つの二次元コードに対する参加登録の上限（60 秒あたり）。
 * 定員の 3 倍まで許し、やり直しや再送に耐えられるようにする。
 */
function joinLimitForRoom(maxParticipants: number): number {
  return Math.max(600, maxParticipants * 3);
}

/** ニックネームの最大長（schemas.ts の nicknameSchema と揃える）。 */
const NICKNAME_MAX_LENGTH = 20;

async function resolveRoomOrThrow(token: string): Promise<RoomDoc> {
  if (!isPlausibleToken(token)) {
    throw new AppError('JOIN_LINK_INVALID');
  }

  const room = await findRoomByJoinTokenHash(hashToken(token));
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
  const snapshot = parseQuizSnapshot(room.quizSnapshot);

  let alreadyJoinedNickname: string | null = null;
  const user = await getOptionalAuthUser();
  if (user) {
    const member = await getMember(room.id, user.uid);
    if (member && member.role === 'participant') {
      alreadyJoinedNickname = member.nickname;
    }
  }

  return {
    roomId: room.id,
    quizTitle: snapshot.title,
    joinOpen: room.joinOpen && room.phase !== 'finished',
    // participantCount は参加登録トランザクションで加算した確定値。
    // 参加者ごとに集計クエリを走らせない。
    participantCount: room.participantCount,
    maxParticipants: room.maxParticipants,
    alreadyJoinedNickname,
    captchaRequired: isCaptchaConfigured(),
  };
}

/**
 * 参加者を登録する。
 *
 * 人数上限・受付終了・ニックネーム重複・二重登録の判定はすべて
 * registerParticipant トランザクションが行う（ここでの事前チェックは早期返却のため）。
 * ここでのレート制限はインスタンスローカルのベストエフォート。
 */
export async function registerParticipant(
  token: string,
  input: RegisterParticipantInput,
  request: Request,
): Promise<JoinRegisterResponse> {
  checkRateLimit(clientKeyFromRequest(request, 'join-register'), {
    limit: JOIN_REGISTER_PER_CLIENT_LIMIT,
    windowMs: 60_000,
  });

  const room = await resolveRoomOrThrow(token);

  // トークン単位でも制限し、1 つの QR への総当たりを抑える。
  // 上限は定員に合わせる（定員 500 のルームを 600 件で頭打ちにしない）。
  checkRateLimit(`join-register-room:${room.id}`, {
    limit: joinLimitForRoom(room.maxParticipants),
    windowMs: 60_000,
  });

  if (room.phase === 'finished') {
    throw new AppError('ROOM_FINISHED');
  }
  if (!room.joinOpen) {
    throw new AppError('JOIN_CLOSED');
  }

  await verifyCaptchaIfConfigured(input.captchaToken, clientIpFromRequest(request));

  const parsedNickname = nicknameSchema.safeParse(input.nickname);
  if (!parsedNickname.success) {
    throw new AppError('NICKNAME_INVALID');
  }
  const nickname = parsedNickname.data;

  const user = await ensureAuthSession();

  // 参加者行の作成・人数上限・重複判定はトランザクションが担う。
  // 再訪（同じ端末・同じ匿名ユーザー）なら既存の行がそのまま返る。
  const registered = await registerParticipantTx(room.id, user.uid, nickname);

  if (!registered.alreadyJoined) {
    logger.info('join.registered', {
      roomId: room.id,
      participantId: registered.participantId,
      // ニックネーム・参加トークンはログへ出さない。
    });
  }

  return {
    roomId: registered.roomId,
    participantId: registered.participantId,
    nickname: registered.nickname,
  };
}

/**
 * 重複しないニックネーム候補を返す（例: 「木村」→「木村2」）。
 * 完全な一意性はトランザクションが担保するため、ここでは候補提示に留める。
 */
export async function suggestNickname(roomId: string, base: string): Promise<string> {
  const parsed = nicknameSchema.safeParse(base);
  const seed = parsed.success ? parsed.data : '参加者';

  const members = await getRoomMembers(roomId, 'participant');
  const taken = new Set(
    members
      .map((member) => member.nicknameLower ?? member.nickname?.toLowerCase() ?? null)
      .filter((nickname): nickname is string => typeof nickname === 'string'),
  );

  if (!taken.has(seed.toLowerCase())) {
    return seed;
  }

  for (let suffix = 2; suffix <= NICKNAME_SUGGESTION_LIMIT; suffix += 1) {
    const suffixText = String(suffix);
    // 上限文字数を超えないよう、必要なら前方を切り詰める。
    const head = seed.slice(0, Math.max(1, NICKNAME_MAX_LENGTH - suffixText.length));
    const candidate = `${head}${suffixText}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  // ここまで埋まっているのは実質ありえないが、最後の手段として乱数を付ける。
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `${seed.slice(0, NICKNAME_MAX_LENGTH - 4)}${random}`;
}
