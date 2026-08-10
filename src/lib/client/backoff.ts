/**
 * Realtime 再接続などで使う指数バックオフ。
 *
 * 1s → 2s → 4s → 8s → …（上限 30s）。
 * 会場では 300 台が同時に切断・再接続しうるため、必ずジッタを入れて
 * 再接続要求が同じ瞬間に集中しないようにする。
 */

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  /** 0-1 の乱数。テストから固定値を渡せるようにする。 */
  random?: () => number;
};

/**
 * attempt は 0 始まり。
 * 戻り値は [delay/2, delay] の範囲でばらつく（half jitter）。
 */
export function computeBackoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? BACKOFF_BASE_MS;
  const maxMs = options.maxMs ?? BACKOFF_MAX_MS;
  const random = options.random ?? Math.random;

  const safeAttempt = Math.max(0, Math.min(attempt, 30));
  const uncapped = baseMs * 2 ** safeAttempt;
  const capped = Math.min(uncapped, maxMs);

  return Math.round(capped / 2 + random() * (capped / 2));
}
