/**
 * クイズ編集の永続化ポート。
 *
 * 実装は `src/infrastructure/firebase/repositories/quiz-repository.ts`。
 *
 * 数値（正解値・許容誤差・範囲）は**必ず文字列**でやり取りする。
 * Firestore の number は倍精度浮動小数点なので、number へ入れた時点で桁落ちする。
 *
 * ※ 実装側の一部の関数は「問題の所在を絞り込むヒント」を任意の追加引数で受け取る。
 *   ヒントは読み取り量を減らすためのもので、この契約には含めない。
 */

import type { AdminChoice, AdminQuestion, AdminQuizDetail, QuizListItem } from '@/types/api';
import type {
  CreateQuestionInput,
  CreateQuizInput,
  UpdateQuestionInput,
  UpdateQuizInput,
} from '@/lib/validation/schemas';

/** 画像 URL を解決するか。スナップショット保存時は解決しない（署名 URL の期限切れを避ける）。 */
export type QuizReadOptions = { resolveUrls?: boolean };

export type QuizRepository = {
  listQuizzes(ownerId: string): Promise<QuizListItem[]>;
  getQuizDetail(quizId: string, options?: QuizReadOptions): Promise<AdminQuizDetail | null>;
  createQuiz(ownerId: string, input: CreateQuizInput): Promise<AdminQuizDetail>;
  updateQuiz(quizId: string, input: UpdateQuizInput): Promise<AdminQuizDetail>;
  archiveQuiz(quizId: string): Promise<void>;
  duplicateQuiz(quizId: string, ownerId: string): Promise<AdminQuizDetail>;
  createQuestion(quizId: string, input: CreateQuestionInput): Promise<AdminQuestion>;
  updateQuestion(questionId: string, input: UpdateQuestionInput): Promise<AdminQuestion>;
  deleteQuestion(questionId: string): Promise<void>;
  reorderQuestions(quizId: string, questionIds: string[]): Promise<void>;
  addChoice(questionId: string): Promise<AdminChoice>;
  deleteChoice(choiceId: string): Promise<void>;
  reorderChoices(questionId: string, choiceIds: string[]): Promise<void>;
  publishQuiz(quizId: string): Promise<void>;
};
