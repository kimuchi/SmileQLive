import 'server-only';

/**
 * ルーム進行のユースケース。
 *
 * 守っている原則:
 * - 参加者へ渡す問題は必ず toPublicQuestion() を通す。
 *   正解選択肢 ID・数値の正解条件・解説・正解画像は phase が answer_revealed 以降でのみ返す。
 * - 参加者 Snapshot に quizSnapshot 全体・参加トークン・投影トークンを含めない。
 * - Firestore が唯一の正。参加者は `rooms/{roomId}/public/state` だけを購読し、
 *   実データはこの Snapshot API から取り直す（公開状態の更新自体が通知になる）。
 * - 状態遷移は infrastructure/firebase/transactions.ts が runTransaction の中で
 *   stateVersion を検証する。ここでの事前チェックは早期返却のため。
 * - 締切判定はサーバー時刻（Cloud Run の時計）。クライアント時刻は一切信用しない。
 */

import { headers } from 'next/headers';
import type { RevealInfo } from '@/domain/answer/answer-dto';
import { describeNumberRule } from '@/domain/answer/number-judgement';
import {
  toPublicQuestion,
  type PublicImage,
  type PublicQuestion,
} from '@/domain/quiz/public-question';
import type { Question } from '@/domain/quiz/question';
import {
  findSnapshotQuestion,
  questionAtPosition,
  type QuizSnapshot,
} from '@/domain/quiz/quiz-snapshot';
import { rankParticipants, topRanking, type RankedParticipant } from '@/domain/room/scoring';
import type { ParticipantSnapshot, StaffSnapshot } from '@/domain/room/snapshot';
import {
  availableActions,
  canTransition,
  requiresQuestionId,
  revealsAnswer,
  showsBreakdown,
  showsQuestion,
  type RoomPhase,
} from '@/domain/room/state-machine';
import { buildSnapshotForQuiz } from '@/application/services/quiz-service';
import { toMyAnswerDto } from '@/application/services/answer-mapper';
import { parseQuizSnapshot } from '@/application/services/quiz-snapshot-codec';
import { resolveQuestionMedia } from '@/application/services/media-service';
import {
  getBreakdown as getAnswerBreakdown,
  getLeaderboard as getParticipantScores,
  getMyAnswer,
} from '@/infrastructure/firebase/repositories/answer-repository';
import {
  consumePresentationLink,
  countActiveParticipants,
  countAnswers,
  countParticipants,
  createPresentationLink,
  createRoom as createRoomDoc,
  getRoomMembers,
  listRooms as listRoomsForOwner,
  rotateJoinToken as rotateJoinTokenHash,
  setJoinOpen as setJoinOpenDoc,
  touchMemberPresence,
  upsertStaffMember,
} from '@/infrastructure/firebase/repositories/room-repository';
import {
  lockQuestionIfExpired as lockQuestionIfExpiredTx,
  transitionRoom as transitionRoomTx,
} from '@/infrastructure/firebase/transactions';
import { toIso, toIsoOr } from '@/infrastructure/firebase/converters';
import { logger } from '@/infrastructure/logging/logger';
import {
  requireHostUser,
  requireParticipant,
  requireQuizAccess,
  requireRoomMember,
  requireRoomOwner,
} from '@/lib/auth/session';
import { ensureAuthSession } from '@/lib/auth/anonymous';
import {
  createJoinToken,
  createPresentationToken,
  hashToken,
  isPlausibleToken,
} from '@/lib/crypto/tokens';
import { AppError } from '@/lib/errors/app-error';
import { appBaseUrl, presentationLinkTtlMinutes } from '@/lib/env/server-env';
import type { RoomActionInput } from '@/lib/validation/schemas';
import type {
  CreateRoomResponse,
  PresentationLinkResponse,
  RoomActionResponse,
  RoomListItem,
  RotateJoinTokenResponse,
} from '@/types/api';
import type { RoomDoc } from '@/types/firestore';

/** 参加人数の既定上限。 */
const DEFAULT_MAX_PARTICIPANTS = 200;

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

/**
 * サーバー時刻。クライアント時計の補正基準として返す。
 * 締切判定そのものもサーバー時刻（Cloud Run）だけで行う。
 */
function serverNow(): string {
  return new Date().toISOString();
}

async function currentBaseUrl(): Promise<string> {
  try {
    return appBaseUrl(await headers());
  } catch {
    return appBaseUrl();
  }
}

export function buildJoinUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/j/${token}`;
}

export function buildPresentationUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/present/token/${token}`;
}

function snapshotOf(room: RoomDoc): QuizSnapshot {
  return parseQuizSnapshot(room.quizSnapshot);
}

function currentQuestionOf(room: RoomDoc, snapshot: QuizSnapshot): Question | null {
  if (!room.currentQuestionId) {
    return null;
  }
  return findSnapshotQuestion(snapshot, room.currentQuestionId) ?? null;
}

function toPublicImage(image: Question['image']): PublicImage | null {
  if (!image) {
    return null;
  }
  return { url: image.url, alt: image.alt, width: image.width, height: image.height };
}

/** 正解発表後にだけ組み立てる。フェーズ判定は呼び出し側の責務。 */
function buildRevealInfo(question: Question): RevealInfo {
  if (question.type === 'choice') {
    const correct = question.choices.find((choice) => choice.isCorrect) ?? null;
    return {
      questionId: question.id,
      explanation: question.explanation,
      revealImage: toPublicImage(question.revealImage),
      correctChoiceId: correct ? correct.id : null,
      answerRuleDisplay: null,
    };
  }

  return {
    questionId: question.id,
    explanation: question.explanation,
    revealImage: toPublicImage(question.revealImage),
    correctChoiceId: null,
    answerRuleDisplay: describeNumberRule(
      question.numberRule,
      question.decimalPlaces,
      question.unit,
    ),
  };
}

function collectImageUrls(question: Question, includeReveal: boolean): string[] {
  const urls: string[] = [];
  if (question.image?.url) {
    urls.push(question.image.url);
  }
  if (includeReveal && question.revealImage?.url) {
    urls.push(question.revealImage.url);
  }
  if (question.type === 'choice') {
    for (const choice of question.choices) {
      if (choice.image?.url) {
        urls.push(choice.image.url);
      }
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// ルーム作成
// ---------------------------------------------------------------------------

export async function createRoom(input: {
  quizId: string;
  maxParticipants?: number;
}): Promise<CreateRoomResponse> {
  // 共有されたクイズでもルームを作れる。ルームの所有者は作成した本人になる。
  const { user, quiz } = await requireQuizAccess(input.quizId);

  if (quiz.status !== 'published') {
    throw new AppError('QUIZ_NOT_PUBLISHED');
  }

  const snapshot = await buildSnapshotForQuiz(input.quizId);
  const { token, tokenHash } = createJoinToken();

  const room = await createRoomDoc({
    ownerId: user.uid,
    quizId: input.quizId,
    joinTokenHash: tokenHash,
    quizSnapshot: snapshot,
    maxParticipants: input.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
  });

  const baseUrl = await currentBaseUrl();

  // 平文の参加トークンはレスポンスでしか返らない。ログへは出さない。
  logger.info('room.created', { roomId: room.id, quizId: input.quizId, userId: user.uid });

  return {
    roomId: room.id,
    joinUrl: buildJoinUrl(baseUrl, token),
    joinToken: token,
    quizTitle: snapshot.title,
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

type SnapshotBaseParts = {
  room: RoomDoc;
  snapshot: QuizSnapshot;
  /** メディア URL 解決済みの現在問題（生のドメイン型。正解情報を含む）。 */
  resolvedQuestion: Question | null;
  publicQuestion: PublicQuestion | null;
  /** メディア URL 解決済みの次問題。投影の先読み用（参加者へは返さない）。 */
  resolvedNextQuestion: Question | null;
};

/**
 * 現在問題と次問題のメディア URL を **1 回の署名要求**でまとめて解決する。
 * 署名 URL の発行はネットワーク往復を伴うため、Snapshot 生成ごとに重複させない。
 *
 * `includeRevealImage: false` を渡すと正解・解説画像の URL をそもそも作らない。
 * 正解発表前の参加者向けにはこれを使う（防御を一段増やす）。
 */
async function loadSnapshotParts(
  room: RoomDoc,
  options: { includeNext?: boolean; includeRevealImage?: boolean } = {},
): Promise<SnapshotBaseParts> {
  const snapshot = snapshotOf(room);
  const current = currentQuestionOf(room, snapshot);
  const next = options.includeNext
    ? (questionAtPosition(snapshot, (room.currentQuestionPosition ?? 0) + 1) ?? null)
    : null;

  const targets: Question[] = [];
  if (current) {
    targets.push(current);
  }
  if (next) {
    targets.push(next);
  }

  const resolved =
    targets.length > 0
      ? await resolveQuestionMedia(targets, {
          includeRevealImage: options.includeRevealImage !== false,
        })
      : [];

  let cursor = 0;
  const resolvedQuestion = current ? (resolved[cursor++] ?? current) : null;
  const resolvedNextQuestion = next ? (resolved[cursor++] ?? next) : null;

  return {
    room,
    snapshot,
    resolvedQuestion,
    publicQuestion: resolvedQuestion ? toPublicQuestion(resolvedQuestion) : null,
    resolvedNextQuestion,
  };
}

/** 投影担当が先読みすべき画像 URL（現在問題＋次問題）。参加者へは返さない。 */
function buildPreloadUrls(parts: SnapshotBaseParts): string[] {
  const urls: string[] = [];
  if (parts.resolvedQuestion) {
    urls.push(...collectImageUrls(parts.resolvedQuestion, true));
  }
  if (parts.resolvedNextQuestion) {
    urls.push(...collectImageUrls(parts.resolvedNextQuestion, true));
  }
  return [...new Set(urls)];
}

export async function getStaffSnapshot(
  roomId: string,
  audience: 'host' | 'presenter',
): Promise<StaffSnapshot> {
  const { member, room } =
    audience === 'host'
      ? await requireRoomMember(roomId, ['host'])
      : await requireRoomMember(roomId, ['host', 'presenter']);

  await touchMemberPresence(roomId, member.id);

  // 投影の先読みのため次問題まで解決する（司会・投影のみ）。
  const parts = await loadSnapshotParts(room, { includeNext: true });
  const { snapshot, resolvedQuestion, publicQuestion } = parts;
  const phase: RoomPhase = room.phase;

  // 司会・投影の画面では正確な件数が要るので、その場で集計クエリを使う。
  const [participantCount, onlineCount, answeredCount] = await Promise.all([
    countParticipants(roomId),
    countActiveParticipants(roomId),
    room.currentQuestionId ? countAnswers(roomId, room.currentQuestionId) : Promise.resolve(0),
  ]);

  const breakdown =
    showsBreakdown(phase) && resolvedQuestion
      ? await getAnswerBreakdown(roomId, resolvedQuestion.id, resolvedQuestion, participantCount)
      : null;

  const reveal =
    revealsAnswer(phase) && resolvedQuestion ? buildRevealInfo(resolvedQuestion) : null;

  const leaderboard =
    phase === 'scoreboard' || phase === 'finished'
      ? topRanking(await getParticipantScores(roomId), snapshot.settings.leaderboardSize)
      : null;

  const base: StaffSnapshot = {
    roomId,
    quizTitle: snapshot.title,
    phase,
    stateVersion: room.stateVersion,
    serverTime: serverNow(),
    currentQuestion: publicQuestion,
    currentQuestionPosition: room.currentQuestionPosition,
    totalQuestions: snapshot.questions.length,
    answerDeadlineAt: toIso(room.answerDeadlineAt),
    showLeaderboard: snapshot.settings.showLeaderboard,
    audience,
    participantCount,
    onlineCount,
    answeredCount,
    joinOpen: room.joinOpen,
    breakdown,
    reveal,
    leaderboard,
    availableActions: availableActions(phase),
    preloadImageUrls: buildPreloadUrls(parts),
  };

  if (audience !== 'host') {
    // 投影担当には参加 URL・参加者一覧を渡さない。
    return base;
  }

  const members = await getRoomMembers(roomId, 'participant');

  return {
    ...base,
    // 参加 URL の平文トークンは保持していないため、司会画面でも再表示しない
    // （必要なら「参加URLを再発行」で新しいトークンを発行する）。
    joinUrl: null,
    participants: members.map((entry) => ({
      participantId: entry.id,
      nickname: entry.nickname ?? '参加者',
      isActive: entry.isActive,
      joinedAt: toIsoOr(entry.joinedAt),
    })),
  };
}

export async function getParticipantSnapshot(roomId: string): Promise<ParticipantSnapshot> {
  const { member, room } = await requireParticipant(roomId);
  await touchMemberPresence(roomId, member.id);

  const phase: RoomPhase = room.phase;
  const revealed = revealsAnswer(phase);

  // 正解発表前は正解・解説画像の URL を作らない（参加者向けの経路に存在させない）。
  const { snapshot, resolvedQuestion, publicQuestion } = await loadSnapshotParts(room, {
    includeRevealImage: revealed,
  });

  // participantCount は参加登録トランザクションで加算した確定値。
  // 参加者が一斉に Snapshot を取りにくるため、ここでは集計クエリを走らせない。
  const participantCount = room.participantCount;

  // 問題を出してよいフェーズでなければ問題そのものを返さない。
  const currentQuestion = showsQuestion(phase) ? publicQuestion : null;

  const storedAnswer = resolvedQuestion
    ? await getMyAnswer(roomId, resolvedQuestion.id, member.id)
    : null;

  const reveal = revealed && resolvedQuestion ? buildRevealInfo(resolvedQuestion) : null;

  let myResult: ParticipantSnapshot['myResult'] = null;
  let leaderboard: RankedParticipant[] | null = null;

  if (revealed) {
    const scores = await getParticipantScores(roomId);
    const ranked = rankParticipants(scores);
    const mine = ranked.find((entry) => entry.participantId === member.id) ?? null;

    if (resolvedQuestion) {
      myResult = {
        isCorrect: storedAnswer?.isCorrect ?? false,
        pointsAwarded: storedAnswer?.pointsAwarded ?? 0,
        totalPoints: mine?.totalPoints ?? 0,
        rank: mine?.rank ?? null,
      };
    }

    // ランキングは「ランキング表示」フェーズと終了後だけ。設定で無効なら出さない。
    if ((phase === 'scoreboard' || phase === 'finished') && snapshot.settings.showLeaderboard) {
      leaderboard = ranked.slice(0, Math.max(0, snapshot.settings.leaderboardSize));
    }
  }

  return {
    roomId,
    quizTitle: snapshot.title,
    phase,
    stateVersion: room.stateVersion,
    serverTime: serverNow(),
    currentQuestion,
    currentQuestionPosition: room.currentQuestionPosition,
    totalQuestions: snapshot.questions.length,
    answerDeadlineAt: toIso(room.answerDeadlineAt),
    showLeaderboard: snapshot.settings.showLeaderboard,
    audience: 'participant',
    participant: {
      participantId: member.id,
      nickname: member.nickname ?? '参加者',
    },
    participantCount,
    myAnswer: toMyAnswerDto(storedAnswer),
    reveal,
    myResult,
    leaderboard,
    joinOpen: room.joinOpen,
  };
}

// ---------------------------------------------------------------------------
// 状態遷移
// ---------------------------------------------------------------------------

export async function transitionRoom(
  roomId: string,
  input: RoomActionInput,
): Promise<RoomActionResponse> {
  const { user, room } = await requireRoomMember(roomId, ['host']);

  // 事前チェックは早期返却のため。確定判定はトランザクション側が同じ条件で行う。
  if (room.stateVersion !== input.expectedVersion) {
    throw new AppError('STATE_VERSION_CONFLICT', {
      details: { currentVersion: room.stateVersion },
    });
  }

  if (room.phase === 'finished') {
    throw new AppError('ROOM_FINISHED');
  }

  if (!canTransition(room.phase, input.action)) {
    throw new AppError('INVALID_TRANSITION');
  }

  let questionId: string | null = null;
  if (requiresQuestionId(input.action)) {
    if (!input.questionId) {
      throw new AppError('QUESTION_NOT_FOUND');
    }
    const snapshot = snapshotOf(room);
    if (!findSnapshotQuestion(snapshot, input.questionId)) {
      throw new AppError('QUESTION_NOT_FOUND');
    }
    questionId = input.questionId;
  }

  // rooms/{id} と rooms/{id}/public/state を同じトランザクションで更新する。
  // 公開状態の更新そのものが参加者・投影への通知になる（別途の送信は不要）。
  const updated = await transitionRoomTx({
    roomId,
    action: input.action,
    expectedVersion: input.expectedVersion,
    questionId,
    actorUserId: user.uid,
  });

  logger.info('room.transitioned', {
    roomId,
    action: input.action,
    stateVersion: updated.stateVersion,
    phase: updated.phase,
  });

  return {
    phase: updated.phase,
    stateVersion: updated.stateVersion,
    serverTime: updated.serverTime,
  };
}

/**
 * 締切時刻を過ぎていれば締切へ遷移する（冪等）。
 * 他の誰かが先に締め切っていた場合や、まだ締切前の場合は null を返す。
 *
 * 判定に使うのは Firestore に保存された answerDeadlineAt とサーバー時刻だけ。
 */
export async function lockQuestionIfExpired(roomId: string): Promise<RoomActionResponse | null> {
  const { user, room } = await requireRoomMember(roomId, ['host', 'presenter']);

  // 投影画面のカウントダウンから何度も呼ばれるため、
  // 明らかに締切前ならトランザクションを開始しない。
  const deadlineMs = room.answerDeadlineAt?.toMillis() ?? null;
  if (room.phase !== 'question_open' || deadlineMs === null || deadlineMs > Date.now()) {
    return null;
  }

  const result = await lockQuestionIfExpiredTx(roomId, user.uid);
  if (!result.locked) {
    // 他の経路で既に締め切られた。冪等な操作なのでエラーにしない。
    return null;
  }

  return {
    phase: result.phase,
    stateVersion: result.stateVersion,
    serverTime: result.serverTime,
  };
}

// ---------------------------------------------------------------------------
// 参加 URL / 投影リンク
// ---------------------------------------------------------------------------

export async function rotateJoinToken(roomId: string): Promise<RotateJoinTokenResponse> {
  await requireRoomOwner(roomId);

  const { token, tokenHash } = createJoinToken();
  const { rotatedAt } = await rotateJoinTokenHash(roomId, tokenHash);
  const baseUrl = await currentBaseUrl();

  logger.info('room.join_token_rotated', { roomId });

  return {
    joinUrl: buildJoinUrl(baseUrl, token),
    joinToken: token,
    rotatedAt,
  };
}

export async function issuePresentationLink(roomId: string): Promise<PresentationLinkResponse> {
  const { user } = await requireRoomOwner(roomId);

  const { token, tokenHash } = createPresentationToken();
  const expiresAt = new Date(Date.now() + presentationLinkTtlMinutes() * 60_000).toISOString();

  await createPresentationLink({
    roomId,
    tokenHash,
    expiresAt,
    createdBy: user.uid,
  });

  const baseUrl = await currentBaseUrl();
  logger.info('room.presentation_link_issued', { roomId });

  return {
    presentationUrl: buildPresentationUrl(baseUrl, token),
    expiresAt,
  };
}

/**
 * 投影用トークンを投影担当メンバーへ引き換える。
 * トークンそのものはログへ出さない。
 */
export async function exchangePresentationToken(token: string): Promise<{ roomId: string }> {
  if (!isPlausibleToken(token)) {
    throw new AppError('PRESENTATION_LINK_INVALID');
  }

  const link = await consumePresentationLink(hashToken(token));
  const user = await ensureAuthSession();
  await upsertStaffMember(link.roomId, user.uid, 'presenter');

  logger.info('room.presentation_token_exchanged', { roomId: link.roomId });

  return { roomId: link.roomId };
}

/**
 * 参加受付の開閉（司会のみ）。
 * `rooms/{id}` と `rooms/{id}/public/state` を同時に更新するため、
 * 参加者側はこの書き込みだけで受付状態の変化に気づける。
 */
export async function setJoinOpen(roomId: string, open: boolean): Promise<void> {
  await requireRoomMember(roomId, ['host']);
  await setJoinOpenDoc(roomId, open);

  logger.info('room.join_open_changed', { roomId, joinOpen: open });
}

/** 司会向けのルーム一覧。 */
export async function listRooms(): Promise<RoomListItem[]> {
  const { user } = await requireHostUser();
  return listRoomsForOwner(user.uid);
}
