import 'server-only';

/**
 * 回答送信・結果参照のユースケース。
 *
 * 原則:
 * - 正誤判定・締切判定・二重回答の防止はすべて
 *   `infrastructure/firebase/transactions.ts` の submitAnswer() が担う。
 *   サービス層では判定せず、読み書きを個別に並べない。
 * - 締切はサーバー時刻（Cloud Run の時計）だけで判定する。
 *   クライアントが送る時刻は一切信用しない。
 * - 数値は normalizeNumberAnswer() で正規化し、raw と正規化文字列の両方を渡す。
 *   **number 型へは決して変換しない**（Firestore の number は倍精度浮動小数点のため）。
 * - 回答レスポンスに正誤を含めない（正解発表前に漏らさない）。
 */

import { NumberNormalizationError, normalizeNumberAnswer } from '@/domain/answer/number-normalizer';
import type { AnswerBreakdown } from '@/domain/answer/answer-dto';
import { findSnapshotQuestion } from '@/domain/quiz/quiz-snapshot';
import { rankParticipants, topRanking, type RankedParticipant } from '@/domain/room/scoring';
import { acceptsAnswers, revealsAnswer, showsBreakdown } from '@/domain/room/state-machine';
import { parseQuizSnapshot } from '@/application/services/quiz-snapshot-codec';
import { toMyAnswerDto } from '@/application/services/answer-mapper';
import {
  getBreakdown as getAnswerBreakdown,
  getLeaderboard as getParticipantScores,
  getMyAnswer,
  getMyTotals,
} from '@/infrastructure/firebase/repositories/answer-repository';
import { countParticipants } from '@/infrastructure/firebase/repositories/room-repository';
import { submitAnswer as submitAnswerTx } from '@/infrastructure/firebase/transactions';
import { logger } from '@/infrastructure/logging/logger';
import { requireParticipant, requireRoomMember } from '@/lib/auth/session';
import { AppError, type AppErrorCode } from '@/lib/errors/app-error';
import { checkRateLimit } from '@/lib/http/rate-limit';
import type { SubmitAnswerRequest } from '@/lib/validation/schemas';
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
  const { user, member, room } = await requireParticipant(roomId);

  // 参加者 1 人あたりの連打を抑える。
  // 二重回答の防止そのものは決定的ドキュメント ID + create() が担保する。
  checkRateLimit(`answer:${member.id}`, { limit: 20, windowMs: 10_000 });

  // 以下はいずれも早期エラー用。最終判定はトランザクションが同じ条件で行う。
  if (!acceptsAnswers(room.phase)) {
    throw new AppError('ANSWER_NOT_OPEN');
  }
  if (!room.currentQuestionId || room.currentQuestionId !== input.questionId) {
    throw new AppError('ANSWER_QUESTION_MISMATCH');
  }

  const snapshot = parseQuizSnapshot(room.quizSnapshot);
  const question = findSnapshotQuestion(snapshot, input.questionId);
  if (!question) {
    throw new AppError('QUESTION_NOT_FOUND');
  }

  // 締切判定はサーバー時刻のみ。クライアントが送る時刻は受け取らない。
  const deadlineMs = room.answerDeadlineAt?.toMillis() ?? null;
  if (deadlineMs !== null && deadlineMs <= Date.now()) {
    throw new AppError('ANSWER_DEADLINE_PASSED');
  }

  let choiceId: string | null = null;
  let numberRaw: string | null = null;
  let numberNormalized: string | null = null;

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
      // 正規化後も文字列のまま扱う。判定は decimal.js だけが行う。
      numberNormalized = normalized.normalizedText;
    } catch (error) {
      if (error instanceof NumberNormalizationError) {
        throw new AppError(NUMBER_ERROR_MAP[error.code] ?? 'INVALID_NUMBER_FORMAT');
      }
      throw new AppError('INVALID_NUMBER_FORMAT', { cause: error });
    }
  }

  // 締切・重複・正誤・得点加算・進捗更新はトランザクション側で確定する。
  const stored = await submitAnswerTx(roomId, user.uid, {
    questionId: input.questionId,
    choiceId,
    numberRaw,
    numberNormalized,
  });

  logger.info('answer.submitted', {
    roomId,
    questionId: input.questionId,
    // 正誤・入力値・参加トークンはログへ出さない。
  });

  return {
    accepted: true,
    answeredAt: stored.answeredAt,
    // 進捗（回答数）は司会・投影向け。参加者画面では表示しない。
    answeredCount: stored.answeredCount,
  };
}

/** 参加者自身の結果。正解発表前は正誤を返さない。 */
export async function getMyResult(roomId: string): Promise<MyResultResponse> {
  const { member, room } = await requireParticipant(roomId);

  // 参加登録トランザクションで加算した確定値。集計クエリを走らせない。
  const participantCount = room.participantCount;
  const questionId = room.currentQuestionId;

  const stored = questionId ? await getMyAnswer(roomId, questionId, member.id) : null;
  const totals = await getMyTotals(roomId, member.id);

  const revealed = revealsAnswer(room.phase);

  let rank: number | null = null;
  if (revealed) {
    const scores = await getParticipantScores(roomId);
    rank =
      rankParticipants(scores).find((entry) => entry.participantId === member.id)?.rank ?? null;
  }

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

  const snapshot = parseQuizSnapshot(room.quizSnapshot);
  const question = findSnapshotQuestion(snapshot, questionId);
  if (!question) {
    throw new AppError('QUESTION_NOT_FOUND');
  }

  const participantCount = await countParticipants(roomId);
  return getAnswerBreakdown(roomId, questionId, question, participantCount);
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

  const snapshot = parseQuizSnapshot(room.quizSnapshot);
  if (member.role === 'participant' && !snapshot.settings.showLeaderboard) {
    return [];
  }

  const scores = await getParticipantScores(roomId);
  return topRanking(scores, limit ?? snapshot.settings.leaderboardSize);
}
