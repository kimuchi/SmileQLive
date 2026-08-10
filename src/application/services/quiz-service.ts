import 'server-only';

/**
 * クイズ編集のユースケース。
 *
 * - すべての操作で所有権を検証してからリポジトリを呼ぶ
 *   （Admin SDK は Security Rules を迂回するため、認可は必ずアプリ側で行う）。
 * - 公開判定は **サーバー側の validateQuizForPublish() だけ**が砦になる。
 *   PostgreSQL 版にあった DB 側の再検証は Firebase では存在しない
 *   （docs/FIRESTORE_MODEL.md §1 の既知のトレードオフ）。
 * - 問題・選択肢は `quizzes/{quizId}/questions/{questionId}` にあり、
 *   questionId だけでは親クイズが分からない。認可で得た quizId / ownerId を
 *   ヒントとしてリポジトリへ渡し、走査のための読み取りを増やさない。
 */

import { validateQuizForPublish, type PublishIssue } from '@/domain/quiz/publish-validation';
import type { QuizSnapshot } from '@/domain/quiz/quiz-snapshot';
import { buildQuizSnapshot } from '@/application/services/quiz-snapshot-codec';
import {
  addChoice as addChoiceRepo,
  archiveQuiz as archiveQuizRepo,
  createQuestion as createQuestionRepo,
  createQuiz as createQuizRepo,
  deleteChoice as deleteChoiceRepo,
  deleteQuestion as deleteQuestionRepo,
  duplicateQuiz as duplicateQuizRepo,
  getQuizDetail,
  listQuizzes as listQuizzesRepo,
  publishQuiz as publishQuizRepo,
  reorderChoices as reorderChoicesRepo,
  reorderQuestions as reorderQuestionsRepo,
  updateQuestion as updateQuestionRepo,
  updateQuiz as updateQuizRepo,
  validateQuizForPublishById,
} from '@/infrastructure/firebase/repositories/quiz-repository';
import {
  requireChoiceOwner,
  requireHostUser,
  requireQuestionOwner,
  requireQuizOwner,
} from '@/lib/auth/session';
import { AppError } from '@/lib/errors/app-error';
import type {
  CreateQuestionInput,
  CreateQuizInput,
  UpdateQuestionInput,
  UpdateQuizInput,
} from '@/lib/validation/schemas';
import type {
  AdminChoice,
  AdminQuestion,
  AdminQuizDetail,
  PublishResponse,
  QuizListItem,
} from '@/types/api';

export async function listQuizzes(): Promise<QuizListItem[]> {
  const { user } = await requireHostUser();
  return listQuizzesRepo(user.uid);
}

export async function getQuiz(quizId: string): Promise<AdminQuizDetail> {
  await requireQuizOwner(quizId);
  const detail = await getQuizDetail(quizId);
  if (!detail) {
    throw new AppError('QUIZ_NOT_FOUND');
  }
  return detail;
}

export async function createQuiz(input: CreateQuizInput): Promise<AdminQuizDetail> {
  const { user } = await requireHostUser();
  return createQuizRepo(user.uid, input);
}

export async function updateQuiz(quizId: string, input: UpdateQuizInput): Promise<AdminQuizDetail> {
  await requireQuizOwner(quizId);
  return updateQuizRepo(quizId, input);
}

export async function archiveQuiz(quizId: string): Promise<void> {
  await requireQuizOwner(quizId);
  await archiveQuizRepo(quizId);
}

export async function duplicateQuiz(quizId: string): Promise<AdminQuizDetail> {
  const { user } = await requireQuizOwner(quizId);
  return duplicateQuizRepo(quizId, user.uid);
}

// ---------------------------------------------------------------------------
// 問題
// ---------------------------------------------------------------------------

export async function createQuestion(
  quizId: string,
  input: CreateQuestionInput,
): Promise<AdminQuestion> {
  await requireQuizOwner(quizId);
  return createQuestionRepo(quizId, input);
}

export async function updateQuestion(
  questionId: string,
  input: UpdateQuestionInput,
): Promise<AdminQuestion> {
  const { user, question } = await requireQuestionOwner(questionId);
  return updateQuestionRepo(questionId, input, { quizId: question.quizId, ownerId: user.uid });
}

export async function deleteQuestion(questionId: string): Promise<void> {
  const { user, question } = await requireQuestionOwner(questionId);
  await deleteQuestionRepo(questionId, { quizId: question.quizId, ownerId: user.uid });
}

export async function reorderQuestions(quizId: string, questionIds: string[]): Promise<void> {
  await requireQuizOwner(quizId);
  await reorderQuestionsRepo(quizId, questionIds);
}

// ---------------------------------------------------------------------------
// 選択肢（問題ドキュメントへ埋め込まれた配列を更新する）
// ---------------------------------------------------------------------------

export async function addChoice(questionId: string): Promise<AdminChoice> {
  const { user, question } = await requireQuestionOwner(questionId);
  if (question.questionType !== 'choice') {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: 'questionId', message: '数値問題には選択肢を追加できません' }],
    });
  }
  return addChoiceRepo(questionId, { quizId: question.quizId, ownerId: user.uid });
}

export async function deleteChoice(choiceId: string): Promise<void> {
  const { user, question } = await requireChoiceOwner(choiceId);
  await deleteChoiceRepo(choiceId, { quizId: question.quizId, ownerId: user.uid });
}

export async function reorderChoices(questionId: string, choiceIds: string[]): Promise<void> {
  const { user, question } = await requireQuestionOwner(questionId);
  await reorderChoicesRepo(questionId, choiceIds, { quizId: question.quizId, ownerId: user.uid });
}

// ---------------------------------------------------------------------------
// 公開
// ---------------------------------------------------------------------------

/**
 * 公開する。
 *
 * 検証に通らない場合は例外ではなく `{ published: false, issues }` を返し、
 * 管理画面が問題ごとの不備を一覧表示できるようにする。
 */
export async function publishQuiz(quizId: string): Promise<PublishResponse> {
  await requireQuizOwner(quizId);

  const validation = await validateQuizForPublishById(quizId);
  if (!validation.ok) {
    return { published: false, issues: dedupeIssues(validation.issues) };
  }

  // リポジトリ側でも公開直前に再検証する（検証と更新の間の編集を取りこぼさない）。
  await publishQuizRepo(quizId);
  return { published: true, issues: [] };
}

/** 同じ問題・同じ理由の指摘を 1 件へまとめる。 */
function dedupeIssues(issues: readonly PublishIssue[]): PublishIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.questionId ?? ''}:${issue.code}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// ルーム作成用スナップショット
// ---------------------------------------------------------------------------

/**
 * ルーム作成時に固定するスナップショットを組み立てる。
 * 画像は `storage://` 参照のまま保存する（署名 URL の期限切れを避けるため）。
 *
 * 認可は呼び出し側（room-service）が済ませていること。
 */
export async function buildSnapshotForQuiz(quizId: string): Promise<QuizSnapshot> {
  // URL 解決は不要（スナップショットへ期限付き URL を入れない）。
  const detail = await getQuizDetail(quizId, { resolveUrls: false });
  if (!detail) {
    throw new AppError('QUIZ_NOT_FOUND');
  }

  const snapshot = buildQuizSnapshot(detail);

  // 読み直さず、いま固定しようとしている内容そのものを検証する。
  const validation = validateQuizForPublish({ title: detail.title, questions: snapshot.questions });
  if (!validation.ok) {
    throw new AppError('QUIZ_PUBLISH_VALIDATION_FAILED', {
      details: dedupeIssues(validation.issues),
    });
  }

  return snapshot;
}
