/**
 * Route Handler 共通ラッパー。
 *
 * - requestId を採番し、開始／終了の構造化ログを出す（route は redactPath 済み）。
 * - 例外は必ず jsonError() へ変換する。未知例外は INTERNAL_ERROR。
 * - 参加トークンを含むパスをそのままログへ出さない。
 *
 * Next.js 16 では動的ルートの params が Promise で渡るため、
 * `defineRoute` は params をジェネリクスで受け取り await してからハンドラーへ渡す。
 */

import type { ZodType } from 'zod';
import { AppError, toAppError } from '@/lib/errors/app-error';
import { jsonError } from '@/lib/errors/api-response';
import { createRequestId, errorFields, logger } from '@/infrastructure/logging/logger';
import { redactPath } from '@/lib/crypto/tokens';

export type RouteContext = { requestId: string; request: Request };

/** 動的セグメントの形。Next.js は catch-all で string[] を渡す。 */
export type RouteParams = Record<string, string | string[] | undefined>;

export type DefinedRouteContext<P extends RouteParams> = {
  requestId: string;
  request: Request;
  params: P;
};

function safePathname(request: Request): string {
  try {
    return redactPath(new URL(request.url).pathname);
  } catch {
    return '[unparsable]';
  }
}

async function runWithLogging(
  routeName: string,
  request: Request,
  run: (requestId: string) => Promise<Response>,
): Promise<Response> {
  const requestId = createRequestId();
  const route = safePathname(request);
  const method = request.method;
  const startedAt = Date.now();

  logger.info('route.start', { requestId, route, method, routeName });

  try {
    const response = await run(requestId);
    logger.info('route.end', {
      requestId,
      route,
      method,
      routeName,
      status: response.status,
      result: response.status < 400 ? 'ok' : 'error',
      durationMs: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    const appError = toAppError(error);
    const isExpected = error instanceof AppError;

    const fields = {
      requestId,
      route,
      method,
      routeName,
      errorCode: appError.code,
      status: appError.status,
      result: 'error' as const,
      durationMs: Date.now() - startedAt,
    };

    if (isExpected && appError.status < 500) {
      logger.info('route.end', fields);
    } else {
      logger.error('route.failed', { ...fields, ...errorFields(error) });
    }

    return jsonError(appError, requestId);
  }
}

/**
 * 動的セグメントを持たないルート用のラッパー。
 *
 * 型引数 `T` は呼び出し側がレスポンス本体の型を明示するためだけに使う（実行時には影響しない）。
 */
export function withRoute<T = unknown>(
  routeName: string,
  handler: (ctx: RouteContext) => Promise<Response>,
): (request: Request) => Promise<Response> {
  type _ResponseBody = T;

  return async function handleRoute(request: Request): Promise<Response> {
    return runWithLogging(routeName, request, (requestId) => handler({ requestId, request }));
  };
}

/**
 * 動的セグメントを持つルート用のラッパー。
 *
 * 使用例:
 * ```ts
 * export const GET = defineRoute<{ roomId: string }>('rooms.snapshot', async (request, ctx) => {
 *   const snapshot = await getStaffSnapshot(ctx.params.roomId, 'host');
 *   return jsonOk({ snapshot });
 * });
 * ```
 */
export function defineRoute<P extends RouteParams = RouteParams>(
  routeName: string,
  handler: (request: Request, ctx: DefinedRouteContext<P>) => Promise<Response>,
): (request: Request, context?: { params: Promise<P> }) => Promise<Response> {
  return async function handleRoute(
    request: Request,
    context?: { params: Promise<P> },
  ): Promise<Response> {
    return runWithLogging(routeName, request, async (requestId) => {
      const params = context ? await context.params : ({} as P);
      return handler(request, { requestId, request, params });
    });
  };
}

/**
 * JSON ボディを Zod で検証する。
 * 失敗時は AppError('VALIDATION_FAILED') に issue 一覧を添えて投げる。
 */
export async function parseJsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: '', message: 'JSON 形式のリクエストボディが必要です' }],
    });
  }

  const result = schema.safeParse(raw);
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

/** クエリ文字列を Zod で検証する。 */
export function parseSearchParams<T>(request: Request, schema: ZodType<T>): T {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    raw[key] = value;
  }
  const result = schema.safeParse(raw);
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

function hostOf(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 変更系 API (POST / PATCH / DELETE) で必ず呼ぶ CSRF 対策。
 * Origin ヘッダーが同一オリジンでなければ ORIGIN_NOT_ALLOWED。
 *
 * process.env を直接読むのは、'server-only' 付きモジュールへ依存させないため。
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');

  if (!origin) {
    // Origin を送らないのは同一オリジンのフォーム送信・ナビゲーションのみ。
    const fetchSite = request.headers.get('sec-fetch-site');
    if (fetchSite === 'same-origin' || fetchSite === 'none') {
      return;
    }
    throw new AppError('ORIGIN_NOT_ALLOWED');
  }

  const originHost = hostOf(origin);
  if (!originHost) {
    throw new AppError('ORIGIN_NOT_ALLOWED');
  }

  const allowed = new Set<string>();

  const configured = hostOf(process.env.APP_BASE_URL ?? null);
  if (configured) {
    allowed.add(configured);
  }

  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedHost) {
    allowed.add(forwardedHost.split(',')[0]?.trim().toLowerCase() ?? '');
  }

  const host = request.headers.get('host');
  if (host) {
    allowed.add(host.trim().toLowerCase());
  }

  try {
    allowed.add(new URL(request.url).host.toLowerCase());
  } catch {
    // request.url が解析できない場合は他の候補で判定する。
  }

  allowed.delete('');

  if (!allowed.has(originHost)) {
    throw new AppError('ORIGIN_NOT_ALLOWED');
  }
}
