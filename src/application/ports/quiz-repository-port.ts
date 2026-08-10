/**
 * クイズ編集の永続化ポート。
 *
 * サービス層はこの型にだけ依存する。実装は
 * `src/infrastructure/supabase/repositories/quiz-repository.ts`。
 *
 * numeric 由来の値（正解値・許容誤差・範囲）は**必ず文字列**でやり取りする。
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
