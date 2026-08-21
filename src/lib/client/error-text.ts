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

/**
 * サーバーが `details.reason` を添えていれば取り出す。
 *
 * 管理画面だけで使う。設定の問題（保存先が無い・権限が無い）を
 * 「失敗しました」で丸めると、直し方にたどり着けないため。
 */
function detailReason(error: unknown): string | null {
  if (!isApiClientError(error)) {
    return null;
  }
  const details: unknown = error.details;
  if (typeof details !== 'object' || details === null) {
    return null;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : null;
}

/**
 * 管理画面向け。利用者向けの文に、原因が分かっていれば理由を添える。
 * 参加者画面では使わない（内部の事情を会場のスマートフォンへ出さない）。
 */
export function toAdminErrorMessage(error: unknown): string {
  const base = toUserErrorMessage(error);
  const reason = detailReason(error);
  return reason === null ? base : `${base}（${reason}）`;
}

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
