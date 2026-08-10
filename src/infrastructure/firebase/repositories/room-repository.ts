import 'server-only';

/**
 * ルーム・メンバー・投影リンクの永続化（Firestore 版）。
 *
 * 方針:
 * - ルームの進行状態は Firestore だけが持つ。インスタンスメモリへキャッシュしない。
 * - `rooms/{roomId}` は quizSnapshot（正解を含む）を持つため参加者へ読ませない。
 *   参加者が購読するのは `rooms/{roomId}/public/state` だけ。
 *   よって **joinOpen などの公開項目は必ず両方を同時に更新する**。
 * - 件数は集計クエリ `count()` で数える（全件読み込みをしない）。
 * - 期限判定（投影リンク）はサーバー時刻で行う。クライアント時刻を信用しない。
 * - 状態遷移は transactions.ts（runTransaction + stateVersion 検証）が担当する。
 */

import { getDb } from '@/infrastructure/firebase/admin';
import {
  answersCollection,
  memberRef,
  membersCollection,
  presentationLinkRef,
  presentationLinksCollection,
  publicStateRef,
  roomRef,
  roomsCollection,
  staffProgressRef,
} from '@/infrastructure/firebase/paths';
import {
  isRecord,
  nowTimestamp,
  readString,
  toIso,
  toIsoOr,
  toTimestamp,
} from '@/infrastructure/firebase/converters';
import { logger } from '@/infrastructure/logging/logger';
import type { QuizSnapshot } from '@/domain/quiz/quiz-snapshot';
import { AppError } from '@/lib/errors/app-error';
import type { RoomListItem } from '@/types/api';
import type {
  PresentationLinkDoc,
  RoomDoc,
  RoomMemberDoc,
  RoomMemberRole,
  RoomPublicStateDoc,
  RoomStaffProgressDoc,
} from '@/types/firestore';

export type CreateRoomDbInput = {
  ownerId: string;
  quizId: string;
  joinTokenHash: string;
  quizSnapshot: QuizSnapshot;
  maxParticipants: number;
};

export type CreatePresentationLinkInput = {
  roomId: string;
  tokenHash: string;
  /** ISO8601。 */
  expiresAt: string;
  createdBy: string;
};

/** ルーム一覧の上限（司会画面の表示用）。 */
const ROOM_LIST_LIMIT = 100;

function snapshotTitle(snapshot: unknown): string {
  if (isRecord(snapshot)) {
    return readString(snapshot, 'title') ?? '無題のクイズ';
  }
  return '無題のクイズ';
}

// ---------------------------------------------------------------------------
// ルーム
// ---------------------------------------------------------------------------

/**
 * ルームを作る。
 * ルーム本体・公開状態・進捗・司会メンバー行を **1 回のバッチ**で書き、
 * 「ルームはあるが公開状態が無い」中途半端な状態を残さない。
 */
export async function createRoom(input: CreateRoomDbInput): Promise<RoomDoc> {
  const now = nowTimestamp();
  const roomId = crypto.randomUUID();

  const room: RoomDoc = {
    id: roomId,
    ownerId: input.ownerId,
    quizId: input.quizId,
    joinTokenHash: input.joinTokenHash,
    joinTokenRotatedAt: now,
    phase: 'lobby',
    quizSnapshot: input.quizSnapshot,
    currentQuestionId: null,
    currentQuestionPosition: null,
    phaseStartedAt: null,
    answerDeadlineAt: null,
    stateVersion: 0,
    joinOpen: true,
    maxParticipants: input.maxParticipants,
    participantCount: 0,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };

  const publicState: RoomPublicStateDoc = {
    roomId,
    phase: 'lobby',
    stateVersion: 0,
    currentQuestionId: null,
    currentQuestionPosition: null,
    totalQuestions: input.quizSnapshot.questions.length,
    answerDeadlineAt: null,
    joinOpen: true,
    participantCount: 0,
    answeredCount: 0,
    updatedAt: now,
  };

  const progress: RoomStaffProgressDoc = {
    roomId,
    stateVersion: 0,
    participantCount: 0,
    onlineCount: 0,
    answeredCount: 0,
    breakdown: null,
    updatedAt: now,
  };

  const host: RoomMemberDoc = {
    id: input.ownerId,
    roomId,
    authUserId: input.ownerId,
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

  const batch = getDb().batch();
  batch.create(roomRef(roomId), room);
  batch.create(publicStateRef(roomId), publicState);
  batch.create(staffProgressRef(roomId), progress);
  batch.create(memberRef(roomId, input.ownerId), host);
  await batch.commit();

  return room;
}

export async function getRoom(roomId: string): Promise<RoomDoc | null> {
  const snapshot = await roomRef(roomId).get();
  return snapshot.data() ?? null;
}

export async function requireRoom(roomId: string): Promise<RoomDoc> {
  const room = await getRoom(roomId);
  if (!room) {
    throw new AppError('ROOM_NOT_FOUND');
  }
  return room;
}

/** 参加 URL のハッシュからルームを引く（等価検索）。 */
export async function findRoomByJoinTokenHash(tokenHash: string): Promise<RoomDoc | null> {
  const snapshot = await roomsCollection().where('joinTokenHash', '==', tokenHash).limit(1).get();

  return snapshot.docs[0]?.data() ?? null;
}

export async function rotateJoinToken(
  roomId: string,
  tokenHash: string,
): Promise<{ rotatedAt: string }> {
  const now = nowTimestamp();
  try {
    await roomRef(roomId).update({
      joinTokenHash: tokenHash,
      joinTokenRotatedAt: now,
      updatedAt: now,
    });
  } catch (error) {
    throw new AppError('ROOM_NOT_FOUND', { cause: error });
  }
  return { rotatedAt: toIsoOr(now) };
}

/** 参加受付の開閉。公開状態も同時に更新する（参加者はこちらしか見られない）。 */
export async function setJoinOpen(roomId: string, open: boolean): Promise<void> {
  const now = nowTimestamp();
  const batch = getDb().batch();
  batch.update(roomRef(roomId), { joinOpen: open, updatedAt: now });
  batch.set(publicStateRef(roomId), { joinOpen: open, updatedAt: now }, { merge: true });
  await batch.commit();
}

export async function listRooms(ownerId: string): Promise<RoomListItem[]> {
  const snapshot = await roomsCollection()
    .where('ownerId', '==', ownerId)
    .orderBy('createdAt', 'desc')
    .limit(ROOM_LIST_LIMIT)
    .get();

  return snapshot.docs.map((doc) => {
    const room = doc.data();
    return {
      id: room.id,
      quizTitle: snapshotTitle(room.quizSnapshot),
      phase: room.phase,
      // participantCount は参加登録トランザクションで加算した確定値。
      participantCount: room.participantCount,
      createdAt: toIsoOr(room.createdAt),
      finishedAt: toIso(room.finishedAt),
    };
  });
}

// ---------------------------------------------------------------------------
// メンバー
// ---------------------------------------------------------------------------

export async function getRoomMembers(
  roomId: string,
  role?: RoomMemberRole,
): Promise<RoomMemberDoc[]> {
  const query = role
    ? membersCollection(roomId).where('role', '==', role)
    : membersCollection(roomId);

  const snapshot = await query.get();
  // 参加順（joined_at 昇順）で返す。件数は最大でも参加人数上限なのでメモリ整列で足りる。
  return snapshot.docs
    .map((doc) => doc.data())
    .sort((a, b) => a.joinedAt.toMillis() - b.joinedAt.toMillis());
}

/** メンバー ID は uid。1 ユーザー 1 行をドキュメント ID で担保している。 */
export async function getMember(roomId: string, authUserId: string): Promise<RoomMemberDoc | null> {
  const snapshot = await memberRef(roomId, authUserId).get();
  return snapshot.data() ?? null;
}

/**
 * 司会・投影担当のメンバー行を用意する。
 * すでに参加者・司会として登録済みなら降格させない。
 */
export async function upsertStaffMember(
  roomId: string,
  authUserId: string,
  role: Extract<RoomMemberRole, 'host' | 'presenter'>,
): Promise<RoomMemberDoc> {
  const now = nowTimestamp();

  return getDb().runTransaction(async (tx) => {
    const ref = memberRef(roomId, authUserId);
    const snapshot = await tx.get(ref);
    const existing = snapshot.data();

    if (existing) {
      if (existing.role === 'host' || existing.role === 'participant') {
        tx.update(ref, { lastSeenAt: now, isActive: true });
        return { ...existing, lastSeenAt: now, isActive: true };
      }
      const updated: RoomMemberDoc = { ...existing, role, lastSeenAt: now, isActive: true };
      tx.set(ref, updated);
      return updated;
    }

    const created: RoomMemberDoc = {
      id: authUserId,
      roomId,
      authUserId,
      role,
      nickname: null,
      nicknameLower: null,
      joinedAt: now,
      lastSeenAt: now,
      isActive: true,
      totalPoints: 0,
      correctCount: 0,
      correctElapsedMsTotal: 0,
    };
    tx.create(ref, created);
    return created;
  });
}

/**
 * 在席時刻の更新。表示補助のための情報なので、失敗しても進行を妨げない。
 * 呼び出し側が await しないことがあるため、この関数は決して throw しない。
 *
 * ※ Supabase 版と違いメンバーはルーム配下にあるため roomId が必要。
 */
export async function touchMemberPresence(roomId: string, memberId: string): Promise<void> {
  try {
    await memberRef(roomId, memberId).update({ lastSeenAt: nowTimestamp(), isActive: true });
  } catch {
    // 意図的に無視する。
  }
}

// ---------------------------------------------------------------------------
// 集計（count() で数える。全件読み込みをしない）
// ---------------------------------------------------------------------------

export async function countParticipants(roomId: string): Promise<number> {
  const snapshot = await membersCollection(roomId).where('role', '==', 'participant').count().get();
  return snapshot.data().count;
}

export async function countActiveParticipants(roomId: string): Promise<number> {
  const snapshot = await membersCollection(roomId)
    .where('role', '==', 'participant')
    .where('isActive', '==', true)
    .count()
    .get();
  return snapshot.data().count;
}

export async function countAnswers(roomId: string, questionId: string): Promise<number> {
  const snapshot = await answersCollection(roomId)
    .where('questionId', '==', questionId)
    .count()
    .get();
  return snapshot.data().count;
}

// ---------------------------------------------------------------------------
// 投影リンク
// ---------------------------------------------------------------------------

export async function createPresentationLink(
  input: CreatePresentationLinkInput,
): Promise<PresentationLinkDoc> {
  const expiresAt = toTimestamp(input.expiresAt);
  if (!expiresAt) {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: 'expiresAt', message: '有効期限の形式が正しくありません' }],
    });
  }

  const link: PresentationLinkDoc = {
    id: crypto.randomUUID(),
    roomId: input.roomId,
    tokenHash: input.tokenHash,
    expiresAt,
    consumedAt: null,
    createdBy: input.createdBy,
    createdAt: nowTimestamp(),
  };

  await presentationLinkRef(link.id).create(link);
  return link;
}

/**
 * 投影リンクを引き当てる。
 * 期限判定はサーバー時刻（Cloud Run）で行う。
 * 一度使ったリンクも期限内なら再読込できる（consumedAt は初回利用時刻の記録）。
 */
export async function consumePresentationLink(tokenHash: string): Promise<PresentationLinkDoc> {
  const snapshot = await presentationLinksCollection()
    .where('tokenHash', '==', tokenHash)
    .limit(1)
    .get();

  const link = snapshot.docs[0]?.data();
  if (!link) {
    throw new AppError('PRESENTATION_LINK_INVALID');
  }

  if (link.expiresAt.toMillis() <= Date.now()) {
    throw new AppError('PRESENTATION_LINK_EXPIRED');
  }

  if (!link.consumedAt) {
    const consumedAt = nowTimestamp();
    try {
      await presentationLinkRef(link.id).update({ consumedAt });
    } catch (error) {
      // 記録できなくても投影は続けられる。
      logger.warn('presentation_link.consume_failed', {
        roomId: link.roomId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return link;
}
