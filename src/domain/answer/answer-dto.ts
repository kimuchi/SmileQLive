import type { PublicImage } from '@/domain/quiz/public-question';

/** 回答送信リクエスト（判別可能 union）。 */
export type SubmitAnswerInput =
  | { questionId: string; choiceId: string }
  | { questionId: string; numberValue: string };

/** 回答送信レスポンス。正誤を含めない。 */
export type SubmitAnswerResult = {
  accepted: true;
  answeredAt: string;
  /** 司会・投影向けの進捗更新に使う。参加者画面では表示しない。 */
  answeredCount?: number;
};

/** 参加者自身の回答（正解発表前でも本人には返してよい）。 */
export type MyAnswer =
  | { questionId: string; type: 'choice'; choiceId: string; answeredAt: string }
  | {
      questionId: string;
      type: 'number';
      raw: string;
      normalizedText: string;
      answeredAt: string;
    };

/** 正解発表後に参加者本人へ返す結果。 */
export type MyQuestionResult = {
  questionId: string;
  isCorrect: boolean;
  pointsAwarded: number;
  totalPoints: number;
  rank: number | null;
  participantCount: number;
};

export type ChoiceBreakdown = {
  questionId: string;
  type: 'choice';
  totalParticipants: number;
  answeredCount: number;
  unansweredCount: number;
  choices: Array<{
    choiceId: string;
    position: number;
    count: number;
    ratio: number;
    isCorrect: boolean;
  }>;
};

export type NumberBreakdown = {
  questionId: string;
  type: 'number';
  totalParticipants: number;
  answeredCount: number;
  unansweredCount: number;
  correctCount: number;
  incorrectCount: number;
  correctRate: number;
  answerRuleDisplay: string;
  frequentValues: Array<{ value: string; count: number }>;
};

export type AnswerBreakdown = ChoiceBreakdown | NumberBreakdown;

export type RevealInfo = {
  questionId: string;
  explanation: string | null;
  revealImage: PublicImage | null;
  /** 選択式のとき正解選択肢 ID。数値式では null。 */
  correctChoiceId: string | null;
  /** 数値式のとき正解条件の表示文字列。選択式では null。 */
  answerRuleDisplay: string | null;
};

export const FREQUENT_VALUES_LIMIT = 5;

/** 数値回答の代表値上位 N 件を求める（同数は数値昇順）。 */
export function summarizeFrequentValues(
  normalizedValues: readonly string[],
  limit: number = FREQUENT_VALUES_LIMIT,
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of normalizedValues) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      return Number(a.value) - Number(b.value);
    })
    .slice(0, limit);
}
