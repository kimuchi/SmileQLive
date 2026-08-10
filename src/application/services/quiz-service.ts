import 'server-only';

/**
 * クイズ編集のユースケース。
 *
 * - すべての操作で所有権を検証してからリポジトリを呼ぶ。
 * - 公開判定はアプリ側の validateQuizForPublish() に加え、
 *   DB 側の validate_quiz_for_publish() の結果も（取得できれば）併合する。
 *   アプリ検証だけを唯一の防波堤にしない。
 */

import { validateQuizForPublish, type PublishIssue } from '@/domain/quiz/publish-validation';
import type { QuizSnapshot } from '@/domain/quiz/quiz-snapshot';
import { buildQuizSnapshot } from '@/application/services/quiz-snapshot-codec';
import { createSupabaseAdminClient } from '@/infrastructure/supabase/admin';
import { logger } from '@/infrastructure/logging/logger';
import { isRecord } from '@/infrastructure/supabase/repositories/row-utils';
import { quizRepository } from '@/infrastructure/supabase/repositories/quiz-repository';
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
  return quizRepository.listQuizzes(user.id);
}

export async function getQuiz(quizId: string): Promise<AdminQuizDetail> {
  await requireQuizOwner(quizId);
  const detail = await quizRepository.getQuizDetail(quizId);
  if (!detail) {
    throw new AppError('QUIZ_NOT_FOUND');
  }
  return detail;
}

export async function createQuiz(input: CreateQuizInput): Promise<AdminQuizDetail> {
  const { user } = await requireHostUser();
  return quizRepository.createQuiz(user.id, input);
}

export async function updateQuiz(quizId: string, input: UpdateQuizInput): Promise<AdminQuizDetail> {
  await requireQuizOwner(quizId);
  return quizRepository.updateQuiz(quizId, input);
}

export async function archiveQuiz(quizId: string): Promise<void> {
  await requireQuizOwner(quizId);
  await quizRepository.archiveQuiz(quizId);
}

export async function duplicateQuiz(quizId: string): Promise<AdminQuizDetail> {
  const { user } = await requireQuizOwner(quizId);
  return quizRepository.duplicateQuiz(quizId, user.id);
}

// ---------------------------------------------------------------------------
// 問題
// ---------------------------------------------------------------------------

export async function createQuestion(
  quizId: string,
  input: CreateQuestionInput,
): Promise<AdminQuestion> {
  await requireQuizOwner(quizId);
  return quizRepository.createQuestion(quizId, input);
}

export async function updateQuestion(
  questionId: string,
  input: UpdateQuestionInput,
): Promise<AdminQuestion> {
  await requireQuestionOwner(questionId);
  return quizRepository.updateQuestion(questionId, input);
}

export async function deleteQuestion(questionId: string): Promise<void> {
  await requireQuestionOwner(questionId);
  await quizRepository.deleteQuestion(questionId);
}

export async function reorderQuestions(quizId: string, questionIds: string[]): Promise<void> {
  await requireQuizOwner(quizId);
  await quizRepository.reorderQuestions(quizId, questionIds);
}

// ---------------------------------------------------------------------------
// 選択肢
// ---------------------------------------------------------------------------

export async function addChoice(questionId: string): Promise<AdminChoice> {
  const { question } = await requireQuestionOwner(questionId);
  if (question.question_type !== 'choice') {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: 'questionId', message: '数値問題には選択肢を追加できません' }],
    });
  }
  return quizRepository.addChoice(questionId);
}

export async function deleteChoice(choiceId: string): Promise<void> {
  await requireChoiceOwner(choiceId);
  await quizRepository.deleteChoice(choiceId);
}

export async function reorderChoices(questionId: string, choiceIds: string[]): Promise<void> {
  await requireQuestionOwner(questionId);
  await quizRepository.reorderChoices(questionId, choiceIds);
}

// ---------------------------------------------------------------------------
// 公開
// ---------------------------------------------------------------------------

function parseDbIssues(payload: unknown): PublishIssue[] {
  if (!isRecord(payload)) {
    return [];
  }
  const raw = payload.issues;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const code = typeof entry.code === 'string' ? entry.code : null;
    const message = typeof entry.message === 'string' ? entry.message : null;
    if (!code || !message) {
      return [];
    }
    const position = entry.questionPosition ?? entry.question_position;
    const questionId = entry.questionId ?? entry.question_id;
    return [
      {
        questionPosition: typeof position === 'number' ? position : null,
        questionId: typeof questionId === 'string' ? questionId : null,
        code,
        message,
      },
    ];
  });
}

/**
 * DB 側の検証結果を取得する。
 * 取得できない場合（関数未配備・権限不足など）は空配列を返し、公開処理は続行する。
 */
async function fetchDbPublishIssues(quizId: string): Promise<PublishIssue[]> {
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.rpc('validate_quiz_for_publish', { p_quiz_id: quizId });
    if (error) {
      logger.warn('quiz.db_validation_unavailable', { quizId, errorMessage: error.message });
      return [];
    }
    return parseDbIssues(data);
  } catch (error) {
    logger.warn('quiz.db_validation_failed', {
      quizId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function publishQuiz(quizId: string): Promise<PublishResponse> {
  await requireQuizOwner(quizId);

  // URL 解決は不要（画像の有無だけを見る）。署名 URL の無駄な発行を避ける。
  const detail = await quizRepository.getQuizDetail(quizId, { resolveUrls: false });
  if (!detail) {
    throw new AppError('QUIZ_NOT_FOUND');
  }

  const snapshot = buildQuizSnapshot(detail);
  const appResult = validateQuizForPublish({
    title: detail.title,
    questions: snapshot.questions,
  });

  const dbIssues = await fetchDbPublishIssues(quizId);

  const seen = new Set<string>();
  const issues = [...appResult.issues, ...dbIssues].filter((issue) => {
    const key = `${issue.questionId ?? ''}:${issue.code}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  if (issues.length > 0) {
    return { published: false, issues };
  }

  await quizRepository.publishQuiz(quizId);
  return { published: true, issues: [] };
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
  const detail = await quizRepository.getQuizDetail(quizId, { resolveUrls: false });
  if (!detail) {
    throw new AppError('QUIZ_NOT_FOUND');
  }

  const snapshot = buildQuizSnapshot(detail);
  const validation = validateQuizForPublish({
    title: detail.title,
    questions: snapshot.questions,
  });
  if (!validation.ok) {
    throw new AppError('QUIZ_PUBLISH_VALIDATION_FAILED', { details: validation.issues });
  }

  return snapshot;
}
