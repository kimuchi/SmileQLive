import 'server-only';

/**
 * PostgreSQL / PostgREST のエラーをアプリ共通エラーへ翻訳する。
 *
 * 方針:
 * - DB 関数は `raise exception 'ANSWER_DEADLINE_PASSED'` のようにアプリのエラーコードを
 *   そのまま message へ入れる契約とする。既知コードならその AppError を投げる。
 * - SQL の生メッセージ・スタックを利用者へ返さない（AppError が日本語文言へ変換する）。
 * - 未知のエラーは INTERNAL_ERROR。
 */

import { AppError, isAppErrorCode, type AppErrorCode } from '@/lib/errors/app-error';
import { logger } from '@/infrastructure/logging/logger';
import { isRecord } from '@/infrastructure/supabase/repositories/row-utils';

export type DbErrorLike = {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
};

/** PostgreSQL の SQLSTATE から推定できる既定コード。 */
const SQLSTATE_FALLBACK: Record<string, AppErrorCode> = {
  '23505': 'ANSWER_ALREADY_EXISTS', // unique_violation（呼び出し側で上書き可能）
  '23503': 'VALIDATION_FAILED', // foreign_key_violation
  '23514': 'VALIDATION_FAILED', // check_violation
  '22003': 'NUMBER_TOO_LARGE', // numeric_value_out_of_range
  '22P02': 'VALIDATION_FAILED', // invalid_text_representation
};

function extractCode(message: string | undefined): AppErrorCode | null {
  if (!message) {
    return null;
  }
  // 'ERROR_CODE' 単体、または 'ERROR_CODE: 追加情報' の形を許容する。
  const head = message.trim().split(/[\s:]/)[0] ?? '';
  if (isAppErrorCode(head)) {
    return head;
  }
  const trimmed = message.trim();
  return isAppErrorCode(trimmed) ? trimmed : null;
}

/**
 * DB エラーを AppError へ変換する。
 * @param overrides SQLSTATE ごとの上書き（例: { '23505': 'NICKNAME_TAKEN' }）
 */
export function toDbAppError(
  error: DbErrorLike | null | undefined,
  overrides: Partial<Record<string, AppErrorCode>> = {},
): AppError {
  if (!error) {
    return new AppError('INTERNAL_ERROR');
  }

  const fromMessage = extractCode(error.message);
  if (fromMessage) {
    return new AppError(fromMessage, { cause: error });
  }

  const sqlstate = error.code ?? '';
  const overridden = overrides[sqlstate];
  if (overridden) {
    return new AppError(overridden, { cause: error });
  }

  const fallback = SQLSTATE_FALLBACK[sqlstate];
  if (fallback && sqlstate !== '23505') {
    return new AppError(fallback, { cause: error });
  }
  if (fallback && sqlstate === '23505') {
    // unique_violation は文脈依存。overrides が無ければ内部エラーとして扱う。
    return new AppError('INTERNAL_ERROR', { cause: error });
  }

  logger.error('db.unexpected_error', {
    sqlstate,
    errorMessage: error.message,
  });
  return new AppError('INTERNAL_ERROR', { cause: error });
}

/** エラーがあれば AppError を投げる。 */
export function throwIfDbError(
  error: DbErrorLike | null | undefined,
  overrides: Partial<Record<string, AppErrorCode>> = {},
): void {
  if (error) {
    throw toDbAppError(error, overrides);
  }
}

/**
 * RPC が JSON で `{ ok: false, code: 'XXX' }` を返した場合にも AppError を投げる。
 * 返却形式が違っても壊れないよう、既知の形だけを検出する。
 */
export function assertRpcOk(payload: unknown): void {
  if (!isRecord(payload)) {
    return;
  }

  if (payload.ok === false || payload.success === false || payload.error !== undefined) {
    const candidates = [payload.code, payload.error_code, payload.errorCode, payload.error];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && isAppErrorCode(candidate)) {
        throw new AppError(candidate);
      }
    }
    throw new AppError('INTERNAL_ERROR', { cause: payload });
  }
}
