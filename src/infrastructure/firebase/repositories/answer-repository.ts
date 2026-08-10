import 'server-only';

/**
 * 回答の参照と集計（Firestore 版）。
 *
 * 方針:
 * - 回答の登録・正誤判定・締切判定は transactions.ts の `submitAnswer()` が行う。
 *   ここでは保存済みの `isCorrect` / `pointsAwarded` を読むだけで、再判定しない。
 * - 数値は `numberNormalized`（文字列）のまま扱う。number へ変換しない。
 * - ランキングは `members` の集計値（回答と同じトランザクションで加算済み）を読む。
 *   回答を全件読まないため、参加者が増えても読み取り量が跳ね上がらない。
 * - 集計を返してよいフェーズかどうかの判断はサービス層の責務。
 */

import {
  answersCollection,
  answerRef,
  memberRef,
  membersCollection,
} from '@/infrastructure/firebase/paths';
import { toIsoOr } from '@/infrastructure/firebase/converters';
import { summarizeFrequentValues, type AnswerBreakdown } from '@/domain/answer/answer-dto';
import { describeNumberRule } from '@/domain/answer/number-judgement';
import type { Question, QuestionType } from '@/domain/quiz/question';
import type { ParticipantScore } from '@/domain/room/scoring';
import type { AnswerDoc } from '@/types/firestore';

/** 保存済みの回答。数値は文字列のまま保持する。 */
export type StoredAnswer = {
  id: string;
  roomId: string;
  questionId: string;
  participantId: string;
  answerType: QuestionType;
  choiceId: string | null;
  /** 参加者の生入力。本人の結果画面にだけ表示する。 */
  numberRaw: string | null;
  /** 正規化済みの数値（文字列）。集計はこちらを使う。 */
  numberValue: string | null;
  /** ISO8601。 */
  answeredAt: string;
  elapsedMs: number;
  isCorrect: boolean;
  pointsAwarded: number;
};

export type MyTotals = {
  totalPoints: number;
  correctCount: number;
  correctElapsedMsTotal: number;
};

function toStoredAnswer(doc: AnswerDoc): StoredAnswer {
  return {
    id: doc.id,
    roomId: doc.roomId,
    questionId: doc.questionId,
    participantId: doc.participantId,
    answerType: doc.answerType,
    choiceId: doc.choiceId,
    numberRaw: doc.numberRaw,
    numberValue: doc.numberNormalized,
    answeredAt: toIsoOr(doc.answeredAt),
    elapsedMs: doc.elapsedMs,
    isCorrect: doc.isCorrect,
    pointsAwarded: doc.pointsAwarded,
  };
}

/**
 * 参加者本人の回答。
 * 正解発表前でも本人には返してよいが、`isCorrect` を参加者へ出すかはサービス層が決める。
 */
export async function getMyAnswer(
  roomId: string,
  questionId: string,
  participantId: string,
): Promise<StoredAnswer | null> {
  const snapshot = await answerRef(roomId, questionId, participantId).get();
  const data = snapshot.data();
  return data ? toStoredAnswer(data) : null;
}

async function fetchAnswersForQuestion(
  roomId: string,
  questionId: string,
): Promise<StoredAnswer[]> {
  const snapshot = await answersCollection(roomId).where('questionId', '==', questionId).get();
  return snapshot.docs.map((doc) => toStoredAnswer(doc.data()));
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
  // 代表値は正規化済みの文字列で集計する（表示は上位 5 件、同数は数値昇順）。
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

/**
 * ルーム全体の得点集計。
 * 順位付け（同点時の規則）は domain/room/scoring の rankParticipants / topRanking が行う。
 */
export async function getLeaderboard(roomId: string): Promise<ParticipantScore[]> {
  const snapshot = await membersCollection(roomId)
    .where('role', '==', 'participant')
    .orderBy('totalPoints', 'desc')
    .orderBy('correctElapsedMsTotal', 'asc')
    .orderBy('joinedAt', 'asc')
    .get();

  return snapshot.docs.map((doc) => {
    const member = doc.data();
    return {
      participantId: member.id,
      nickname: member.nickname ?? '参加者',
      totalPoints: member.totalPoints,
      correctCount: member.correctCount,
      correctElapsedMsTotal: member.correctElapsedMsTotal,
      joinedAt: toIsoOr(member.joinedAt),
    };
  });
}

/** 参加者本人の累計。members の集計値をそのまま読む。 */
export async function getMyTotals(roomId: string, participantId: string): Promise<MyTotals> {
  const snapshot = await memberRef(roomId, participantId).get();
  const member = snapshot.data();
  if (!member) {
    return { totalPoints: 0, correctCount: 0, correctElapsedMsTotal: 0 };
  }
  return {
    totalPoints: member.totalPoints,
    correctCount: member.correctCount,
    correctElapsedMsTotal: member.correctElapsedMsTotal,
  };
}

export const answerRepository = {
  getMyAnswer,
  getBreakdown,
  getLeaderboard,
  getMyTotals,
};
