/**
 * 管理系 API ルートの共通ヘルパー。
 *
 * ルート本体を薄く保つための道具だけを置く。
 * ビジネスロジックは application/services 側に置き、ここへは書かない。
 *
 * `_lib` は Next.js の private folder（先頭アンダースコア）なので URL へは公開されない。
 */

import type { ZodType } from 'zod';
import { getQuiz } from '@/application/services/quiz-service';
import { requireQuestionOwner } from '@/lib/auth/session';
import { AppError } from '@/lib/errors/app-error';
import { defineRoute, type DefinedRouteContext, type RouteParams } from '@/lib/http/route-helpers';
import { uuidSchema } from '@/lib/validation/schemas';
import type { AdminQuestion } from '@/types/api';

/** アーカイブ結果（本体を持たない応答）。 */
export type ArchivedResponse = { archived: true };

/** 削除結果（本体を持たない応答）。 */
export type DeletedResponse = { deleted: true };

/**
 * 動的セグメント付きルートのラッパー。
 *
 * `defineRoute()` が返す関数は第 2 引数が任意（context?）だが、
 * Next.js 16 が生成する型検査は「第 2 引数が `{ params: Promise<...> }` である」ことを要求する。
 * ここで必須引数の形へ包み直し、型検査と実行時の呼び出し規約の双方を満たす。
 */
export function withParams<P extends RouteParams>(
  routeName: string,
  handler: (request: Request, ctx: DefinedRouteContext<P>) => Promise<Response>,
): (request: Request, context: { params: Promise<P> }) => Promise<Response> {
  const run = defineRoute<P>(routeName, handler);
  return function handleRoute(request, context) {
    return run(request, context);
  };
}

/** 動的セグメントを UUID として検証する。形式不正は 400。 */
export function requireUuidParam(value: string | string[] | undefined, field: string): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const result = uuidSchema.safeParse(raw);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: field, message: '識別子の形式が正しくありません' }],
    });
  }
  return result.data;
}

/**
 * JSON ボディ以外（multipart のフィールドなど）を Zod で検証する。
 * 失敗時のエラー形状は parseJsonBody() と揃える。
 */
export function parseValue<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', {
      details: result.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/**
 * 選択肢の追加・削除・並べ替えの後に、更新後の問題を 1 件取り直す。
 *
 * 所有権は requireQuestionOwner()（問題→クイズの所有者照合）と
 * getQuiz()（クイズ所有者照合）の両方で確認する。
 * クライアントから来た識別子をそのまま信用しない。
 */
export async function loadAdminQuestion(questionId: string): Promise<AdminQuestion> {
  const { question } = await requireQuestionOwner(questionId);
  const quiz = await getQuiz(question.quiz_id);

  const found = quiz.questions.find((item) => item.id === questionId);
  if (!found) {
    throw new AppError('QUESTION_NOT_FOUND');
  }
  return found;
}
