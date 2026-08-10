import type { Question } from '@/domain/quiz/question';

/**
 * ルーム作成時に固定するクイズ全体のスナップショット。
 * 開催中に元クイズが編集されても、進行中の内容は変わらない。
 *
 * 注意: `quiz_snapshot` には正解情報が含まれる。参加者へ直接 SELECT させず、
 * 参加者向け DTO へ変換してから返すこと。
 */

export type QuizSnapshotSettings = {
  showLeaderboard: boolean;
  soundTheme: string;
  leaderboardSize: number;
};

export type QuizSnapshot = {
  quizId: string;
  title: string;
  settings: QuizSnapshotSettings;
  questions: Question[];
};

export function findSnapshotQuestion(
  snapshot: QuizSnapshot,
  questionId: string,
): Question | undefined {
  return snapshot.questions.find((question) => question.id === questionId);
}

export function questionAtPosition(snapshot: QuizSnapshot, position: number): Question | undefined {
  return snapshot.questions.find((question) => question.position === position);
}

export function nextQuestion(snapshot: QuizSnapshot, currentPosition: number | null): Question | undefined {
  const target = (currentPosition ?? 0) + 1;
  return questionAtPosition(snapshot, target);
}

export function totalQuestions(snapshot: QuizSnapshot): number {
  return snapshot.questions.length;
}

export function isLastQuestion(snapshot: QuizSnapshot, position: number | null): boolean {
  if (position === null) {
    return false;
  }
  return position >= snapshot.questions.length;
}
