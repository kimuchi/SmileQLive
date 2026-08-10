import 'server-only';

/**
 * 認証・認可のサーバー専用ヘルパー。
 *
 * 方針:
 * - 認証状態は必ず **HttpOnly のセッションクッキー**から取得する。
 *   クライアントから送られた userId / role は一切信用しない。
 * - Admin SDK は Security Rules を迂回するため、**認可はここで必ず行う**
 *   （docs/FIRESTORE_MODEL.md §4）。
 * - 匿名ユーザー（参加者・投影担当）は profiles を持たないため、
 *   管理系操作は requireHostUser() で弾く。
 * - 他人の資源の存在有無を漏らさないため、所有者不一致は 404 ではなく 403 で統一する。
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { getDb } from '@/infrastructure/firebase/admin';
import { readSessionCookie, verifySessionCookie } from '@/infrastructure/firebase/session-cookie';
import { allowedAuthDomains } from '@/lib/env/server-env';
import { AppError } from '@/lib/errors/app-error';
import {
  SIGN_IN_PROVIDER,
  emailDomain,
  isAllowedAuthDomain,
  type AuthUser,
} from '@/lib/auth/shared';
import {
  COLLECTIONS,
  type ChoiceEmbedded,
  type QuestionDoc,
  type QuizDoc,
  type RoomDoc,
  type RoomMemberDoc,
  type RoomMemberRole,
} from '@/types/firestore';

export type { AuthUser } from '@/lib/auth/shared';

/** Supabase 版からの移行互換。呼び出し側の `User` という名前を残すための別名。 */
export type User = AuthUser;

// ---------------------------------------------------------------------------
// 認証
// ---------------------------------------------------------------------------

/** DecodedIdToken をアプリ都合の AuthUser へ変換する。 */
function toAuthUser(decoded: DecodedIdToken): AuthUser {
  const email = typeof decoded.email === 'string' ? decoded.email : null;
  const displayName = typeof decoded.name === 'string' ? decoded.name : null;
  const isAnonymous = decoded.firebase.sign_in_provider === SIGN_IN_PROVIDER.anonymous;

  return {
    uid: decoded.uid,
    id: decoded.uid,
    email,
    isAnonymous,
    displayName,
    hostedDomain: isAnonymous ? null : emailDomain(email),
  };
}

/**
 * 認証済みなら AuthUser、未認証なら null。
 *
 * 参照系で毎回呼ばれるため既定では失効確認を行わない（Firebase への往復を減らす）。
 * 管理操作の入口では requireHostUser() が失効確認込みで再検証する。
 */
export async function getOptionalAuthUser(
  options: { checkRevoked?: boolean } = {},
): Promise<AuthUser | null> {
  const cookieValue = await readSessionCookie();
  if (!cookieValue) {
    return null;
  }

  const decoded = await verifySessionCookie(cookieValue, {
    checkRevoked: options.checkRevoked ?? false,
  });
  if (!decoded) {
    return null;
  }

  return toAuthUser(decoded);
}

/** 認証必須。匿名セッションも「認証済み」として扱う（参加者導線で使う）。 */
export async function requireAuthUser(): Promise<AuthUser> {
  const user = await getOptionalAuthUser();
  if (!user) {
    throw new AppError('UNAUTHENTICATED');
  }
  return user;
}

/**
 * 管理・司会向け。次の 3 つを同時に満たすことを要求する。
 *
 * 1. 匿名セッションでないこと
 * 2. 許可ドメイン（ALLOWED_AUTH_DOMAINS）のメールアドレスであること（未設定なら制限しない）
 * 3. profiles/{uid} が存在すること（招待制。自己登録させない）
 *
 * ここだけは失効確認込みで再検証する。ログアウト済みのクッキーで
 * 管理操作が通ってしまうことを防ぐため。
 */
export async function requireHostUser(): Promise<{ user: AuthUser; profileId: string }> {
  const user = await getOptionalAuthUser({ checkRevoked: true });
  if (!user) {
    throw new AppError('UNAUTHENTICATED');
  }

  if (user.isAnonymous) {
    throw new AppError('FORBIDDEN');
  }

  if (!isAllowedAuthDomain(user.email, allowedAuthDomains())) {
    // メールアドレスそのものはログへ出さない（ドメインのみ）。
    throw new AppError('FORBIDDEN', { details: { reason: 'domain_not_allowed' } });
  }

  const profile = await getDb().collection(COLLECTIONS.profiles).doc(user.uid).get();
  if (!profile.exists) {
    throw new AppError('FORBIDDEN', { details: { reason: 'profile_not_found' } });
  }

  return { user, profileId: user.uid };
}

// ---------------------------------------------------------------------------
// 所有権の照合
// ---------------------------------------------------------------------------

async function fetchQuiz(quizId: string): Promise<QuizDoc> {
  const snapshot = await getDb().collection(COLLECTIONS.quizzes).doc(quizId).get();
  const data = snapshot.data() as QuizDoc | undefined;
  if (!snapshot.exists || !data) {
    throw new AppError('QUIZ_NOT_FOUND');
  }
  return data;
}

async function fetchRoom(roomId: string): Promise<RoomDoc> {
  const snapshot = await getDb().collection(COLLECTIONS.rooms).doc(roomId).get();
  const data = snapshot.data() as RoomDoc | undefined;
  if (!snapshot.exists || !data) {
    throw new AppError('ROOM_NOT_FOUND');
  }
  return data;
}

/**
 * 問題を ID だけで引く。
 *
 * 問題は `quizzes/{quizId}/questions/{questionId}` にあり親が分からないため、
 * コレクショングループの単一等値クエリで探す（自動生成される単一フィールド索引で足りる）。
 */
async function fetchQuestion(questionId: string): Promise<QuestionDoc> {
  const snapshot = await getDb()
    .collectionGroup(COLLECTIONS.questions)
    .where('id', '==', questionId)
    .limit(1)
    .get();

  const doc = snapshot.docs[0];
  const data = doc?.data() as QuestionDoc | undefined;
  if (!data) {
    throw new AppError('QUESTION_NOT_FOUND');
  }
  return data;
}

/** クイズの所有者であることを要求する。 */
export async function requireQuizOwner(quizId: string): Promise<{ user: AuthUser; quiz: QuizDoc }> {
  const { user } = await requireHostUser();
  const quiz = await fetchQuiz(quizId);

  if (quiz.ownerId !== user.uid) {
    throw new AppError('FORBIDDEN');
  }

  return { user, quiz };
}

/** 問題の所有者（＝親クイズの所有者）であることを要求する。 */
export async function requireQuestionOwner(
  questionId: string,
): Promise<{ user: AuthUser; question: QuestionDoc; quiz: QuizDoc }> {
  const { user } = await requireHostUser();
  const question = await fetchQuestion(questionId);

  if (question.ownerId !== user.uid) {
    throw new AppError('FORBIDDEN');
  }

  // 問題側の ownerId が古い可能性を排除するため、親クイズでも照合する。
  const quiz = await fetchQuiz(question.quizId);
  if (quiz.ownerId !== user.uid) {
    throw new AppError('FORBIDDEN');
  }

  return { user, question, quiz };
}

/**
 * 選択肢の所有者であることを要求する。
 *
 * 選択肢は問題ドキュメントへ配列として埋め込まれている（最大 5 件、docs/FIRESTORE_MODEL.md §2）ため、
 * 選択肢 ID から直接引くことができない。
 * **自分が所有する問題だけ**を対象に走査する（他人の問題は読み込まない）。
 */
export async function requireChoiceOwner(
  choiceId: string,
): Promise<{ user: AuthUser; choice: ChoiceEmbedded; question: QuestionDoc; quiz: QuizDoc }> {
  const { user } = await requireHostUser();

  const snapshot = await getDb()
    .collectionGroup(COLLECTIONS.questions)
    .where('ownerId', '==', user.uid)
    .get();

  for (const doc of snapshot.docs) {
    const question = doc.data() as QuestionDoc | undefined;
    if (!question) {
      continue;
    }
    const choice = question.choices.find((item) => item.id === choiceId);
    if (!choice) {
      continue;
    }

    const quiz = await fetchQuiz(question.quizId);
    if (quiz.ownerId !== user.uid) {
      throw new AppError('FORBIDDEN');
    }
    return { user, choice, question, quiz };
  }

  // 他人の選択肢でも「見つからない」で統一し、存在有無を漏らさない。
  throw new AppError('QUESTION_NOT_FOUND');
}

/** ルームの所有者であることを要求する。 */
export async function requireRoomOwner(roomId: string): Promise<{ user: AuthUser; room: RoomDoc }> {
  const { user } = await requireHostUser();
  const room = await fetchRoom(roomId);

  if (room.ownerId !== user.uid) {
    throw new AppError('FORBIDDEN');
  }

  return { user, room };
}

/**
 * ルームメンバーであり、かつ指定した役割のいずれかであることを要求する。
 * 参加者だけを許可する場合は requireParticipant を使う。
 *
 * メンバードキュメントの ID は uid（Security Rules の `members/$(uid())` と一致させる）。
 */
export async function requireRoomMember(
  roomId: string,
  roles: RoomMemberRole[],
): Promise<{ user: AuthUser; member: RoomMemberDoc; room: RoomDoc }> {
  const user = await requireAuthUser();
  const room = await fetchRoom(roomId);

  const snapshot = await getDb()
    .collection(COLLECTIONS.rooms)
    .doc(roomId)
    .collection(COLLECTIONS.members)
    .doc(user.uid)
    .get();

  const member = snapshot.data() as RoomMemberDoc | undefined;

  if (!member || !roles.includes(member.role)) {
    // ルーム所有者は host メンバー行が無くても host として扱う（作成直後の復旧用）。
    if (roles.includes('host') && room.ownerId === user.uid) {
      const restored = await ensureHostMember(roomId, user);
      return { user, member: restored, room };
    }
    throw new AppError(roles.includes('participant') ? 'NOT_A_PARTICIPANT' : 'FORBIDDEN');
  }

  return { user, member, room };
}

/** 参加者であることを要求する。 */
export async function requireParticipant(
  roomId: string,
): Promise<{ user: AuthUser; member: RoomMemberDoc; room: RoomDoc }> {
  return requireRoomMember(roomId, ['participant']);
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * ルーム所有者の host メンバー行を復旧する。
 *
 * 得点系のフィールドは既存値を壊さないよう merge で書き、
 * 集計対象にならない host 行として最小限だけ用意する。
 */
async function ensureHostMember(roomId: string, user: AuthUser): Promise<RoomMemberDoc> {
  const now = Timestamp.now();
  const member: RoomMemberDoc = {
    id: user.uid,
    roomId,
    authUserId: user.uid,
    role: 'host',
    nickname: null,
    nicknameLower: null,
    joinedAt: now,
    lastSeenAt: now,
    isActive: true,
    totalPoints: 0,
    correctCount: 0,
    correctElapsedMsTotal: 0,
  };

  const ref = getDb()
    .collection(COLLECTIONS.rooms)
    .doc(roomId)
    .collection(COLLECTIONS.members)
    .doc(user.uid);

  await ref.set(member, { merge: true });
  return member;
}
