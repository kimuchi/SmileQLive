/**
 * ブラウザから同一オリジンの API を呼ぶための共通クライアント。
 *
 * 方針:
 * - 認証は Cookie (Firebase セッションクッキー) に依存するため credentials: 'same-origin'。
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
const TIMEOUT_MESSAGE = '通信に時間がかかっています。電波状況を確認して、もう一度お試しください';

/**
 * 応答を待つ上限。
 *
 * これが無いと、サーバーが応答しないときに参加者の画面が
 * 「読み込んでいます」のまま止まり続ける（会場では復帰手段が無くなる）。
 * 必ず失敗として扱い、画面に再試行の導線を出せるようにする。
 *
 * 回答送信がタイムアウトしても二重回答にはならない。
 * 再送すると既存の回答が 409 ANSWER_ALREADY_EXISTS で返り、
 * 参加者画面は「回答済み」へ復元する（決定的ドキュメントID による一意性）。
 */
export const READ_TIMEOUT_MS = 8_000;
export const WRITE_TIMEOUT_MS = 20_000;

/**
 * メソッドごとの既定タイムアウト。
 *
 * GET は再実行しても副作用が無いので**早く失敗させる**。
 * 参加者が「読み込んでいます」を眺め続けるより、8 秒で諦めて
 * 再試行ボタンを出すほうが会場では復帰が早い。
 *
 * 書き込みは逆に余裕を持たせる。会場 Wi-Fi が遅いだけで
 * 「送れなかった」と表示すると、参加者が何度も押してしまう。
 */
function defaultTimeoutFor(method: HttpMethod): number {
  return method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
}
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

export type ApiRequestInit = Omit<RequestInit, 'method' | 'body'> & {
  /** 応答を待つ上限 (ms)。既定は GET 8 秒 / 書き込み 20 秒。0 以下を渡すと無制限。 */
  timeoutMs?: number;
};

/**
 * 呼び出し側の signal とタイムアウトを合成する。
 * どちらか早い方で中断する。
 */
function buildSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; isTimeout: () => boolean } {
  if (timeoutMs <= 0) {
    return { signal: callerSignal ?? undefined, isTimeout: () => false };
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const isTimeout = () => timeoutSignal.aborted;

  if (!callerSignal) {
    return { signal: timeoutSignal, isTimeout };
  }
  return { signal: AbortSignal.any([callerSignal, timeoutSignal]), isTimeout };
}

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

  const { timeoutMs = defaultTimeoutFor(method), signal: callerSignal, ...restInit } = init;
  const { signal, isTimeout } = buildSignal(callerSignal, timeoutMs);

  let response: Response;
  try {
    response = await fetch(path, {
      referrerPolicy: 'origin',
      ...restInit,
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    // 呼び出し側が中断した場合は、その中断をそのまま伝える（画面遷移など）。
    if (callerSignal?.aborted) {
      throw error;
    }
    throw new ApiClientError({
      code: NETWORK_ERROR_CODE,
      message: isTimeout() ? TIMEOUT_MESSAGE : NETWORK_ERROR_MESSAGE,
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
