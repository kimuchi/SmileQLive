import 'server-only';

/**
 * ルーム進行のユースケース。
 *
 * 守っている原則:
 * - 参加者へ渡す問題は必ず toPublicQuestion() を通す。
 *   正解選択肢 ID・数値の正解条件・解説・正解画像は phase が answer_revealed 以降でのみ返す。
 * - 参加者 Snapshot に quiz_snapshot 全体・参加トークン・投影トークンを含めない。
 * - DB が唯一の正。Realtime は「変わった」ことだけを通知し、詳細は Snapshot で取得させる。
 * - 状態遷移は DB の RPC が state_version を検証する。アプリ側の事前チェックは早期返却のため。
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
import { publicEventTypeForPhase, type PublicEventPayload } from '@/domain/room/events';
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
import { answerRepository } from '@/infrastructure/supabase/repositories/answer-repository';
import {
  countActiveParticipants,
  roomRepository,
} from '@/infrastructure/supabase/repositories/room-repository';
import { buildEnvelope, eventPublisher } from '@/infrastructure/supabase/realtime/publisher';
import { logger } from '@/infrastructure/logging/logger';
import {
  requireHostUser,
  requireParticipant,
  requireQuizOwner,
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
import type { RoomRow } from '@/types/database';

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

/**
 * サーバー時刻。クライアント時計の補正基準として返す。
 * 締切判定そのものは DB 側 (`now()`) が行う。
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

function snapshotOf(room: RoomRow): QuizSnapshot {
  return parseQuizSnapshot(room.quiz_snapshot);
}

function currentQuestionOf(room: RoomRow, snapshot: QuizSnapshot): Question | null {
  if (!room.current_question_id) {
    return null;
  }
  return findSnapshotQuestion(snapshot, room.current_question_id) ?? null;
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

async function publishPhaseEvent(room: RoomRow): Promise<void> {
  const payload: PublicEventPayload = {
    phase: room.phase,
    questionId: room.current_question_id,
    questionPosition: room.current_question_position,
    answerDeadlineAt: room.answer_deadline_at,
  };

  await eventPublisher.publishPublicEvent(
    room.id,
    buildEnvelope({
      type: publicEventTypeForPhase(room.phase),
      roomId: room.id,
      stateVersion: room.state_version,
      payload,
      serverTime: serverNow(),
    }),
  );
}

// ---------------------------------------------------------------------------
// ルーム作成
// ---------------------------------------------------------------------------

export async function createRoom(input: {
  quizId: string;
  maxParticipants?: number;
}): Promise<CreateRoomResponse> {
  const { user, quiz } = await requireQuizOwner(input.quizId);

  if (quiz.status !== 'published') {
    throw new AppError('QUIZ_NOT_PUBLISHED');
  }

  const snapshot = await buildSnapshotForQuiz(input.quizId);
  const { token, tokenHash } = createJoinToken();

  const room = await roomRepository.createRoom({
    ownerId: user.id,
    quizId: input.quizId,
    joinTokenHash: tokenHash,
    quizSnapshot: snapshot,
    maxParticipants: input.maxParticipants ?? 200,
  });

  const baseUrl = await currentBaseUrl();

  logger.info('room.created', { roomId: room.id, quizId: input.quizId, userId: user.id });

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
  room: RoomRow;
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
 */
async function loadSnapshotParts(
  room: RoomRow,
  options: { includeNext?: boolean } = {},
): Promise<SnapshotBaseParts> {
  const snapshot = snapshotOf(room);
  const current = currentQuestionOf(room, snapshot);
  const next = options.includeNext
    ? (questionAtPosition(snapshot, (room.current_question_position ?? 0) + 1) ?? null)
    : null;

  const targets: Question[] = [];
  if (current) {
    targets.push(current);
  }
  if (next) {
    targets.push(next);
  }

  const resolved = targets.length > 0 ? await resolveQuestionMedia(targets) : [];

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

  await roomRepository.touchMemberPresence(member.id);

  // 投影の先読みのため次問題まで解決する（司会・投影のみ）。
  const parts = await loadSnapshotParts(room, { includeNext: true });
  const { snapshot, resolvedQuestion, publicQuestion } = parts;
  const phase: RoomPhase = room.phase;

  const participantCount = await roomRepository.countParticipants(roomId);
  const onlineCount = await countActiveParticipants(roomId);
  const answeredCount = room.current_question_id
    ? await roomRepository.countAnswers(roomId, room.current_question_id)
    : 0;

  const breakdown =
    showsBreakdown(phase) && resolvedQuestion
      ? await answerRepository.getBreakdown(
          roomId,
          resolvedQuestion.id,
          resolvedQuestion,
          participantCount,
        )
      : null;

  const reveal =
    revealsAnswer(phase) && resolvedQuestion ? buildRevealInfo(resolvedQuestion) : null;

  const leaderboard =
    phase === 'scoreboard' || phase === 'finished'
      ? topRanking(await answerRepository.getLeaderboard(roomId), snapshot.settings.leaderboardSize)
      : null;

  const base: StaffSnapshot = {
    roomId,
    quizTitle: snapshot.title,
    phase,
    stateVersion: room.state_version,
    serverTime: serverNow(),
    currentQuestion: publicQuestion,
    currentQuestionPosition: room.current_question_position,
    totalQuestions: snapshot.questions.length,
    answerDeadlineAt: room.answer_deadline_at,
    showLeaderboard: snapshot.settings.showLeaderboard,
    audience,
    participantCount,
    onlineCount,
    answeredCount,
    joinOpen: room.join_open,
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

  const members = await roomRepository.getRoomMembers(roomId, 'participant');

  return {
    ...base,
    // 参加 URL の平文トークンは保持していないため、司会画面でも再表示しない
    // （必要なら「参加URLを再発行」で新しいトークンを発行する）。
    joinUrl: null,
    participants: members.map((entry) => ({
      participantId: entry.id,
      nickname: entry.nickname ?? '参加者',
      isActive: entry.is_active,
      joinedAt: entry.joined_at,
    })),
  };
}

export async function getParticipantSnapshot(roomId: string): Promise<ParticipantSnapshot> {
  const { member, room } = await requireParticipant(roomId);
  await roomRepository.touchMemberPresence(member.id);

  const { snapshot, resolvedQuestion, publicQuestion } = await loadSnapshotParts(room);
  const phase: RoomPhase = room.phase;
  const participantCount = await roomRepository.countParticipants(roomId);

  // 問題を出してよいフェーズでなければ問題そのものを返さない。
  const currentQuestion = showsQuestion(phase) ? publicQuestion : null;

  const storedAnswer = resolvedQuestion
    ? await answerRepository.getMyAnswer(roomId, resolvedQuestion.id, member.id)
    : null;

  const revealed = revealsAnswer(phase);
  const reveal = revealed && resolvedQuestion ? buildRevealInfo(resolvedQuestion) : null;

  let myResult: ParticipantSnapshot['myResult'] = null;
  let leaderboard: RankedParticipant[] | null = null;

  if (revealed) {
    const scores = await answerRepository.getLeaderboard(roomId);
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
    stateVersion: room.state_version,
    serverTime: serverNow(),
    currentQuestion,
    currentQuestionPosition: room.current_question_position,
    totalQuestions: snapshot.questions.length,
    answerDeadlineAt: room.answer_deadline_at,
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
    joinOpen: room.join_open,
  };
}

// ---------------------------------------------------------------------------
// 状態遷移
// ---------------------------------------------------------------------------

export async function transitionRoom(
  roomId: string,
  input: RoomActionInput,
): Promise<RoomActionResponse> {
  const { room } = await requireRoomMember(roomId, ['host']);

  if (room.state_version !== input.expectedVersion) {
    throw new AppError('STATE_VERSION_CONFLICT', {
      details: { currentVersion: room.state_version },
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

  const updated = await roomRepository.transitionRoom({
    roomId,
    action: input.action,
    expectedVersion: input.expectedVersion,
    questionId,
  });

  // DB 更新の確定後にだけ通知する。送信失敗は無視される。
  await publishPhaseEvent(updated);

  logger.info('room.transitioned', {
    roomId,
    action: input.action,
    stateVersion: updated.state_version,
    phase: updated.phase,
  });

  return {
    phase: updated.phase,
    stateVersion: updated.state_version,
    serverTime: serverNow(),
  };
}

/**
 * 締切時刻を過ぎていれば締切へ遷移する（冪等）。
 * 他の誰かが先に締め切っていたら null を返す。
 */
export async function lockQuestionIfExpired(roomId: string): Promise<RoomActionResponse | null> {
  const { room } = await requireRoomMember(roomId, ['host', 'presenter']);

  if (room.phase !== 'question_open' || !room.answer_deadline_at) {
    return null;
  }

  const deadlineMs = Date.parse(room.answer_deadline_at);
  if (Number.isNaN(deadlineMs) || deadlineMs > Date.now()) {
    return null;
  }

  try {
    const updated = await roomRepository.transitionRoom({
      roomId,
      action: 'lock_question',
      expectedVersion: room.state_version,
      questionId: null,
    });
    await publishPhaseEvent(updated);
    return {
      phase: updated.phase,
      stateVersion: updated.state_version,
      serverTime: serverNow(),
    };
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === 'STATE_VERSION_CONFLICT' || error.code === 'INVALID_TRANSITION')
    ) {
      // 他の経路で既に締め切られた。冪等な操作なのでエラーにしない。
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 参加 URL / 投影リンク
// ---------------------------------------------------------------------------

export async function rotateJoinToken(roomId: string): Promise<RotateJoinTokenResponse> {
  await requireRoomOwner(roomId);

  const { token, tokenHash } = createJoinToken();
  const { rotatedAt } = await roomRepository.rotateJoinToken(roomId, tokenHash);
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

  await roomRepository.createPresentationLink({
    roomId,
    tokenHash,
    expiresAt,
    createdBy: user.id,
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
 * トークンそのものはログへ出さない（redactPath 済みのパスのみ出す）。
 */
export async function exchangePresentationToken(token: string): Promise<{ roomId: string }> {
  if (!isPlausibleToken(token)) {
    throw new AppError('PRESENTATION_LINK_INVALID');
  }

  const link = await roomRepository.consumePresentationLink(hashToken(token));
  const user = await ensureAuthSession();
  await roomRepository.upsertStaffMember(link.room_id, user.id, 'presenter');

  logger.info('room.presentation_token_exchanged', { roomId: link.room_id });

  return { roomId: link.room_id };
}

export async function setJoinOpen(roomId: string, open: boolean): Promise<void> {
  const { room } = await requireRoomMember(roomId, ['host']);
  await roomRepository.setJoinOpen(roomId, open);

  await eventPublisher.publishPublicEvent(
    roomId,
    buildEnvelope({
      type: 'room.lobby_updated',
      roomId,
      stateVersion: room.state_version,
      payload: {
        phase: room.phase,
        questionId: room.current_question_id,
        questionPosition: room.current_question_position,
        answerDeadlineAt: room.answer_deadline_at,
      } satisfies PublicEventPayload,
      serverTime: serverNow(),
    }),
  );
}

/** 司会向けのルーム一覧。 */
export async function listRooms(): Promise<RoomListItem[]> {
  const { user } = await requireHostUser();
  return roomRepository.listRooms(user.id);
}
