import 'server-only';

/**
 * 回答送信・結果参照のユースケース。
 *
 * 原則:
 * - 正誤判定は DB (numeric) が唯一の正。ここでは判定しない。
 * - 締切判定もサーバー / DB 時刻。クライアントが送る時刻は一切信用しない。
 * - 数値は normalizeNumberAnswer() で正規化し、raw と normalizedText の両方を DB へ渡す。
 * - 回答レスポンスに正誤を含めない（正解発表前に漏らさない）。
 */

import { NumberNormalizationError, normalizeNumberAnswer } from '@/domain/answer/number-normalizer';
import type { AnswerBreakdown } from '@/domain/answer/answer-dto';
import { findSnapshotQuestion } from '@/domain/quiz/quiz-snapshot';
import { rankParticipants, topRanking, type RankedParticipant } from '@/domain/room/scoring';
import { acceptsAnswers, revealsAnswer, showsBreakdown } from '@/domain/room/state-machine';
import { parseQuizSnapshot } from '@/application/services/quiz-snapshot-codec';
import { toMyAnswerDto } from '@/application/services/answer-mapper';
import { answerRepository } from '@/infrastructure/supabase/repositories/answer-repository';
import { roomRepository } from '@/infrastructure/supabase/repositories/room-repository';
import { buildEnvelope, eventPublisher } from '@/infrastructure/supabase/realtime/publisher';
import { logger } from '@/infrastructure/logging/logger';
import { requireParticipant, requireRoomMember } from '@/lib/auth/session';
import { AppError, type AppErrorCode } from '@/lib/errors/app-error';
import { checkRateLimit } from '@/lib/http/rate-limit';
import type { SubmitAnswerRequest } from '@/lib/validation/schemas';
import type { AnswersProgressPayload } from '@/domain/room/events';
import type { MyResultResponse, SubmitAnswerResponse } from '@/types/api';

/** 正規化エラーコードをアプリ共通エラーへ写す。 */
const NUMBER_ERROR_MAP: Record<string, AppErrorCode> = {
  INVALID_NUMBER_LENGTH: 'INVALID_NUMBER_LENGTH',
  INVALID_NUMBER_FORMAT: 'INVALID_NUMBER_FORMAT',
  NUMBER_TOO_LARGE: 'NUMBER_TOO_LARGE',
  NUMBER_TOO_MANY_DECIMALS: 'NUMBER_TOO_MANY_DECIMALS',
};

export async function submitAnswer(
  roomId: string,
  input: SubmitAnswerRequest,
): Promise<SubmitAnswerResponse> {
  const { member, room } = await requireParticipant(roomId);

  // 参加者 1 人あたりの連打を抑える。重複防止そのものは DB の UNIQUE 制約が担保する。
  checkRateLimit(`answer:${member.id}`, { limit: 20, windowMs: 10_000 });

  if (!acceptsAnswers(room.phase)) {
    throw new AppError('ANSWER_NOT_OPEN');
  }
  if (!room.current_question_id || room.current_question_id !== input.questionId) {
    throw new AppError('ANSWER_QUESTION_MISMATCH');
  }

  const snapshot = parseQuizSnapshot(room.quiz_snapshot);
  const question = findSnapshotQuestion(snapshot, input.questionId);
  if (!question) {
    throw new AppError('QUESTION_NOT_FOUND');
  }

  // 早期エラー用の締切チェック。最終判定は DB の submit_answer が行う。
  if (room.answer_deadline_at) {
    const deadlineMs = Date.parse(room.answer_deadline_at);
    if (!Number.isNaN(deadlineMs) && deadlineMs <= Date.now()) {
      throw new AppError('ANSWER_DEADLINE_PASSED');
    }
  }

  let choiceId: string | null = null;
  let numberRaw: string | null = null;
  let numberValue: string | null = null;

  if (question.type === 'choice') {
    if (input.choiceId === undefined) {
      throw new AppError('ANSWER_TYPE_MISMATCH');
    }
    const exists = question.choices.some((choice) => choice.id === input.choiceId);
    if (!exists) {
      throw new AppError('INVALID_CHOICE');
    }
    choiceId = input.choiceId;
  } else {
    if (input.numberValue === undefined) {
      throw new AppError('ANSWER_TYPE_MISMATCH');
    }
    try {
      const normalized = normalizeNumberAnswer(input.numberValue);
      numberRaw = normalized.raw;
      numberValue = normalized.normalizedText;
    } catch (error) {
      if (error instanceof NumberNormalizationError) {
        throw new AppError(NUMBER_ERROR_MAP[error.code] ?? 'INVALID_NUMBER_FORMAT');
      }
      throw new AppError('INVALID_NUMBER_FORMAT', { cause: error });
    }
  }

  const stored = await answerRepository.submitAnswer({
    roomId,
    questionId: input.questionId,
    participantId: member.id,
    choiceId,
    numberRaw,
    numberValue,
  });

  const answeredCount = await roomRepository.countAnswers(roomId, input.questionId);
  const participantCount = await roomRepository.countParticipants(roomId);

  // 司会・投影の進捗表示用。参加者画面では使わない。DB 確定後にだけ送る。
  await eventPublisher.publishStaffEvent(
    roomId,
    buildEnvelope({
      type: 'answers.progress',
      roomId,
      stateVersion: room.state_version,
      payload: {
        questionId: input.questionId,
        answeredCount,
        participantCount,
        answerRate: participantCount > 0 ? answeredCount / participantCount : 0,
      } satisfies AnswersProgressPayload,
    }),
  );

  logger.info('answer.submitted', {
    roomId,
    questionId: input.questionId,
    // 正誤・入力値はログへ出さない。
  });

  return {
    accepted: true,
    answeredAt: stored.answeredAt,
    answeredCount,
  };
}

/** 参加者自身の結果。正解発表前は正誤を返さない。 */
export async function getMyResult(roomId: string): Promise<MyResultResponse> {
  const { member, room } = await requireParticipant(roomId);

  const participantCount = await roomRepository.countParticipants(roomId);
  const questionId = room.current_question_id;

  const stored = questionId
    ? await answerRepository.getMyAnswer(roomId, questionId, member.id)
    : null;

  const totals = await answerRepository.getMyTotals(roomId, member.id);

  let rank: number | null = null;
  if (revealsAnswer(room.phase)) {
    const scores = await answerRepository.getLeaderboard(roomId);
    rank =
      rankParticipants(scores).find((entry) => entry.participantId === member.id)?.rank ?? null;
  }

  const revealed = revealsAnswer(room.phase);

  return {
    questionId,
    myAnswer: toMyAnswerDto(stored),
    // 正解発表前は絶対に正誤を返さない。
    isCorrect: revealed && stored ? stored.isCorrect : null,
    pointsAwarded: revealed && stored ? stored.pointsAwarded : null,
    totalPoints: revealed ? totals.totalPoints : 0,
    rank,
    participantCount,
  };
}

/** 司会・投影向けの集計。締切前は null を返す。 */
export async function getBreakdown(
  roomId: string,
  questionId: string,
): Promise<AnswerBreakdown | null> {
  const { room } = await requireRoomMember(roomId, ['host', 'presenter']);

  if (!showsBreakdown(room.phase)) {
    return null;
  }

  const snapshot = parseQuizSnapshot(room.quiz_snapshot);
  const question = findSnapshotQuestion(snapshot, questionId);
  if (!question) {
    throw new AppError('QUESTION_NOT_FOUND');
  }

  const participantCount = await roomRepository.countParticipants(roomId);
  return answerRepository.getBreakdown(roomId, questionId, question, participantCount);
}

/**
 * ランキング。
 * 参加者からも呼べるが、正解発表前のフェーズでは空配列を返す。
 */
export async function getLeaderboard(roomId: string, limit?: number): Promise<RankedParticipant[]> {
  const { member, room } = await requireRoomMember(roomId, ['host', 'presenter', 'participant']);

  if (member.role === 'participant' && !revealsAnswer(room.phase)) {
    return [];
  }

  const snapshot = parseQuizSnapshot(room.quiz_snapshot);
  if (member.role === 'participant' && !snapshot.settings.showLeaderboard) {
    return [];
  }

  const scores = await answerRepository.getLeaderboard(roomId);
  return topRanking(scores, limit ?? snapshot.settings.leaderboardSize);
}
