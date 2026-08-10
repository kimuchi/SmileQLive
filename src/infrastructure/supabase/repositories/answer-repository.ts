import 'server-only';

/**
 * 回答の登録と集計。
 *
 * 方針:
 * - 正誤判定・締切判定・重複防止はすべて DB の `submit_answer` RPC が行う。
 *   ここでは JavaScript の number による再判定を一切しない。
 * - `numeric` は `::text` キャストで文字列のまま取り出す。
 * - 集計は保存済みの answers.is_correct / points_awarded を読むだけ。
 */

import { createSupabaseAdminClient } from '@/infrastructure/supabase/admin';
import { createSupabaseServerClient } from '@/infrastructure/supabase/server';
import { assertRpcOk, throwIfDbError } from '@/infrastructure/supabase/repositories/db-errors';
import {
  isRecord,
  readBoolean,
  readEnum,
  readInt,
  readNumericText,
  readString,
  requireString,
} from '@/infrastructure/supabase/repositories/row-utils';
import { AppError } from '@/lib/errors/app-error';
import { summarizeFrequentValues, type AnswerBreakdown } from '@/domain/answer/answer-dto';
import { describeNumberRule } from '@/domain/answer/number-judgement';
import { QUESTION_TYPES, type Question } from '@/domain/quiz/question';
import type { ParticipantScore } from '@/domain/room/scoring';
import type {
  AnswerRepository,
  MyTotals,
  StoredAnswer,
  SubmitAnswerDbInput,
} from '@/application/ports/answer-repository-port';

const ANSWER_SELECT = [
  'id',
  'room_id',
  'question_id',
  'participant_id',
  'answer_type',
  'choice_id',
  'number_raw',
  'answered_at',
  'elapsed_ms',
  'is_correct',
  'points_awarded',
  'number_value::text',
].join(',');

function mapAnswer(record: Record<string, unknown>): StoredAnswer {
  return {
    id: requireString(record, 'id'),
    roomId: requireString(record, 'room_id'),
    questionId: requireString(record, 'question_id'),
    participantId: requireString(record, 'participant_id'),
    answerType: readEnum(record, 'answer_type', QUESTION_TYPES) ?? 'choice',
    choiceId: readString(record, 'choice_id'),
    numberRaw: readString(record, 'number_raw'),
    numberValue: readNumericText(record, 'number_value'),
    answeredAt: readString(record, 'answered_at') ?? new Date().toISOString(),
    elapsedMs: readInt(record, 'elapsed_ms', 0),
    isCorrect: readBoolean(record, 'is_correct', false),
    pointsAwarded: readInt(record, 'points_awarded', 0),
  };
}

function mapAnswers(data: unknown): StoredAnswer[] {
  if (!Array.isArray(data)) {
    return [];
  }
  return data.filter(isRecord).map(mapAnswer);
}

/**
 * 回答を登録する。
 * 締切・重複・正誤はすべて DB 側で確定するため、RPC は利用者スコープのクライアントで呼ぶ
 * （participant を auth.uid() から解決させるため）。
 */
export async function submitAnswer(input: SubmitAnswerDbInput): Promise<StoredAnswer> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('submit_answer', {
    p_room_id: input.roomId,
    p_question_id: input.questionId,
    p_choice_id: input.choiceId ?? null,
    p_number_raw: input.numberRaw ?? null,
    p_number_value: input.numberValue ?? null,
  });

  throwIfDbError(error, { '23505': 'ANSWER_ALREADY_EXISTS' });
  assertRpcOk(data);

  const stored = await getMyAnswer(input.roomId, input.questionId, input.participantId);
  if (!stored) {
    throw new AppError('INTERNAL_ERROR');
  }
  return stored;
}

export async function getMyAnswer(
  roomId: string,
  questionId: string,
  participantId: string,
): Promise<StoredAnswer | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('answers')
    .select(ANSWER_SELECT)
    .eq('room_id', roomId)
    .eq('question_id', questionId)
    .eq('participant_id', participantId)
    .maybeSingle();

  throwIfDbError(error);
  return isRecord(data) ? mapAnswer(data) : null;
}

async function fetchAnswersForQuestion(
  roomId: string,
  questionId: string,
): Promise<StoredAnswer[]> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('answers')
    .select(ANSWER_SELECT)
    .eq('room_id', roomId)
    .eq('question_id', questionId);
  throwIfDbError(error);
  return mapAnswers(data);
}

/**
 * 問題ごとの集計。
 * 正解発表前に呼ばないこと（フェーズ判定はサービス層が行う）。
 */
export async function getBreakdown(
  roomId: string,
  questionId: string,
  question: Question,
  totalParticipants: number,
): Promise<AnswerBreakdown> {
  const answers = await fetchAnswersForQuestion(roomId, questionId);
  const answeredCount = answers.length;
  const unansweredCount = Math.max(0, totalParticipants - answeredCount);

  if (question.type === 'choice') {
    const counts = new Map<string, number>();
    for (const answer of answers) {
      if (answer.choiceId) {
        counts.set(answer.choiceId, (counts.get(answer.choiceId) ?? 0) + 1);
      }
    }

    return {
      questionId,
      type: 'choice',
      totalParticipants,
      answeredCount,
      unansweredCount,
      choices: [...question.choices]
        .sort((a, b) => a.position - b.position)
        .map((choice) => {
          const count = counts.get(choice.id) ?? 0;
          return {
            choiceId: choice.id,
            position: choice.position,
            count,
            ratio: answeredCount > 0 ? count / answeredCount : 0,
            isCorrect: choice.isCorrect,
          };
        }),
    };
  }

  const correctCount = answers.filter((answer) => answer.isCorrect).length;
  const normalizedValues = answers
    .map((answer) => answer.numberValue)
    .filter((value): value is string => typeof value === 'string');

  return {
    questionId,
    type: 'number',
    totalParticipants,
    answeredCount,
    unansweredCount,
    correctCount,
    incorrectCount: answeredCount - correctCount,
    correctRate: answeredCount > 0 ? correctCount / answeredCount : 0,
    answerRuleDisplay: describeNumberRule(
      question.numberRule,
      question.decimalPlaces,
      question.unit,
    ),
    frequentValues: summarizeFrequentValues(normalizedValues),
  };
}

/** ルーム全体の得点集計。順位付けは domain/room/scoring が行う。 */
export async function getLeaderboard(roomId: string): Promise<ParticipantScore[]> {
  const admin = createSupabaseAdminClient();

  const { data: members, error: memberError } = await admin
    .from('room_members')
    .select('id,nickname,joined_at')
    .eq('room_id', roomId)
    .eq('role', 'participant');
  throwIfDbError(memberError);

  const { data: answers, error: answerError } = await admin
    .from('answers')
    .select('participant_id,is_correct,points_awarded,elapsed_ms')
    .eq('room_id', roomId);
  throwIfDbError(answerError);

  const totals = new Map<string, { points: number; correct: number; elapsed: number }>();
  for (const answer of answers ?? []) {
    const entry = totals.get(answer.participant_id) ?? { points: 0, correct: 0, elapsed: 0 };
    entry.points += answer.points_awarded;
    if (answer.is_correct) {
      entry.correct += 1;
      entry.elapsed += answer.elapsed_ms;
    }
    totals.set(answer.participant_id, entry);
  }

  return (members ?? []).map((member) => {
    const entry = totals.get(member.id) ?? { points: 0, correct: 0, elapsed: 0 };
    return {
      participantId: member.id,
      nickname: member.nickname ?? '参加者',
      totalPoints: entry.points,
      correctCount: entry.correct,
      correctElapsedMsTotal: entry.elapsed,
      joinedAt: member.joined_at,
    };
  });
}

export async function getMyTotals(roomId: string, participantId: string): Promise<MyTotals> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('answers')
    .select('is_correct,points_awarded,elapsed_ms')
    .eq('room_id', roomId)
    .eq('participant_id', participantId);
  throwIfDbError(error);

  let totalPoints = 0;
  let correctCount = 0;
  let correctElapsedMsTotal = 0;
  for (const answer of data ?? []) {
    totalPoints += answer.points_awarded;
    if (answer.is_correct) {
      correctCount += 1;
      correctElapsedMsTotal += answer.elapsed_ms;
    }
  }

  return { totalPoints, correctCount, correctElapsedMsTotal };
}

export const answerRepository: AnswerRepository = {
  submitAnswer,
  getMyAnswer,
  getBreakdown,
  getLeaderboard,
  getMyTotals,
};
