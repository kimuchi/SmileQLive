/**
 * GET  /api/admin/quizzes  クイズ一覧（自分が所有するもののみ）
 * POST /api/admin/quizzes  クイズ新規作成
 */

import { createQuiz, listQuizzes } from '@/application/services/quiz-service';
import { jsonCreated, jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody, withRoute } from '@/lib/http/route-helpers';
import { createQuizSchema } from '@/lib/validation/schemas';
import type { QuizDetailResponse, QuizListResponse } from '@/types/api';

export const dynamic = 'force-dynamic';

export const GET = withRoute<QuizListResponse>('admin.quizzes.list', async () => {
  // 所有者の絞り込みはサービス層（requireHostUser + ownerId）で行う。
  const quizzes = await listQuizzes();
  return jsonOk<QuizListResponse>({ quizzes });
});

export const POST = withRoute<QuizDetailResponse>('admin.quizzes.create', async ({ request }) => {
  assertSameOrigin(request);

  // owner_id はクライアントから受け取らない。認証済みユーザーをサービス層が設定する。
  const input = await parseJsonBody(request, createQuizSchema);
  const quiz = await createQuiz(input);

  return jsonCreated<QuizDetailResponse>({ quiz });
});
