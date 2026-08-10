/**
 * ブラウザから同一オリジンの API を呼ぶための共通クライアント。
 *
 * 方針:
 * - 認証は Cookie (Supabase Auth) に依存するため credentials: 'same-origin'。
 * - 会場進行では常に最新状態が要るので cache: 'no-store'。
 * - Referer に参加トークン付き URL を載せないよう referrerPolicy: 'origin' を既定にする。
 * - 非 2xx は ApiError 形状 { error: { code, message, requestId } } を解釈し
 *   ApiClientError として投げる。SQL エラー・スタックは画面へ出さない。
 */

import type { ApiError } from '@/lib/errors/api-response';

/** 通信そのものに失敗したとき（サーバーからの応答が無い）に使う内部コード。 */
export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';
/** 応答は返ったが ApiError 形状として解釈できなかったときの内部コード。 */
export const UNEXPECTED_RESPONSE_CODE = 'UNEXPECTED_RESPONSE';

const NETWORK_ERROR_MESSAGE = '通信できませんでした。電波状況を確認して、もう一度お試しください';
const UNEXPECTED_RESPONSE_MESSAGE = '処理に失敗しました。時間をおいて再度お試しください';

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  readonly details?: unknown;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    requestId: string;
    details?: unknown;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'ApiClientError';
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.details = input.details;
  }

  /** 通信断・タイムアウトなど、リトライで回復しうるか。 */
  get isNetworkError(): boolean {
    return this.code === NETWORK_ERROR_CODE;
  }
}

export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type ApiRequestInit = Omit<RequestInit, 'method' | 'body'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** ApiError 形状を安全に取り出す。想定外の形は null を返す。 */
function parseApiError(body: unknown): ApiError['error'] | null {
  if (!isRecord(body) || !isRecord(body.error)) {
    return null;
  }
  const { code, message, requestId, details } = body.error;
  if (typeof code !== 'string' || typeof message !== 'string') {
    return null;
  }
  return {
    code,
    message,
    requestId: typeof requestId === 'string' ? requestId : '',
    ...(details !== undefined ? { details } : {}),
  };
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) {
      return null;
    }
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function mergeHeaders(base: HeadersInit, extra: HeadersInit | undefined): Headers {
  const headers = new Headers(base);
  if (extra) {
    new Headers(extra).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return headers;
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body: unknown,
  init: ApiRequestInit = {},
): Promise<T> {
  const hasBody = body !== undefined;
  const headers = mergeHeaders(
    hasBody
      ? { Accept: 'application/json', 'Content-Type': 'application/json' }
      : { Accept: 'application/json' },
    init.headers,
  );

  let response: Response;
  try {
    response = await fetch(path, {
      referrerPolicy: 'origin',
      ...init,
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new ApiClientError({
      code: NETWORK_ERROR_CODE,
      message: NETWORK_ERROR_MESSAGE,
      status: 0,
      requestId: '',
      cause: error,
    });
  }

  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  const payload = await readJsonSafely(response);

  if (!response.ok) {
    const apiError = parseApiError(payload);
    if (apiError) {
      throw new ApiClientError({
        code: apiError.code,
        message: apiError.message,
        status: response.status,
        requestId: apiError.requestId,
        details: apiError.details,
      });
    }
    throw new ApiClientError({
      code: UNEXPECTED_RESPONSE_CODE,
      message: UNEXPECTED_RESPONSE_MESSAGE,
      status: response.status,
      requestId: '',
    });
  }

  return payload as T;
}

export function apiGet<T>(path: string, init?: ApiRequestInit): Promise<T> {
  return request<T>('GET', path, undefined, init);
}

export function apiPost<T>(path: string, body?: unknown, init?: ApiRequestInit): Promise<T> {
  return request<T>('POST', path, body, init);
}

export function apiPatch<T>(path: string, body?: unknown, init?: ApiRequestInit): Promise<T> {
  return request<T>('PATCH', path, body, init);
}

export function apiPut<T>(path: string, body?: unknown, init?: ApiRequestInit): Promise<T> {
  return request<T>('PUT', path, body, init);
}

export function apiDelete<T>(path: string, body?: unknown, init?: ApiRequestInit): Promise<T> {
  return request<T>('DELETE', path, body, init);
}
