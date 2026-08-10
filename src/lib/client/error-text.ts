/**
 * 例外を利用者向けの日本語文へ変換する。
 *
 * - 技術用語・スタックトレース・SQL エラーを画面へ出さない。
 * - サーバーが返した message は APP_ERROR_DEFINITIONS 由来の日本語なのでそのまま使う。
 * - 想定外の例外は必ず汎用文へ丸める。
 */

import { ApiClientError, NETWORK_ERROR_CODE, isApiClientError } from '@/lib/client/api-client';
import { isAppErrorCode, userMessageForCode } from '@/lib/errors/app-error';

const FALLBACK_MESSAGE = '処理に失敗しました。時間をおいて再度お試しください';
const NETWORK_MESSAGE = '通信できませんでした。電波状況を確認して、もう一度お試しください';

export function toUserErrorMessage(error: unknown): string {
  if (error === null || error === undefined) {
    return FALLBACK_MESSAGE;
  }

  if (isApiClientError(error)) {
    if (error.code === NETWORK_ERROR_CODE) {
      return NETWORK_MESSAGE;
    }
    if (isAppErrorCode(error.code)) {
      return userMessageForCode(error.code);
    }
    return error.message || FALLBACK_MESSAGE;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  return FALLBACK_MESSAGE;
}

/** 参加者へ「もう一度お試しください」と促してよいエラーか。 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) {
    return false;
  }
  if (error.isNetworkError) {
    return true;
  }
  return error.status >= 500 || error.status === 429;
}

/** 画面を再読込すべきエラーか（状態がずれている場合）。 */
export function requiresReload(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) {
    return false;
  }
  return error.code === 'STATE_VERSION_CONFLICT' || error.code === 'ANSWER_QUESTION_MISMATCH';
}
