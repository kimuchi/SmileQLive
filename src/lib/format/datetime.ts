/**
 * 日時の日本語表示ヘルパー。
 *
 * - 会場運用は日本国内前提のため既定タイムゾーンは Asia/Tokyo。
 * - サーバー・クライアントの双方から呼べるよう副作用を持たせない。
 * - 締切判定には使わない（判定は必ずサーバー / DB 時刻で行う）。
 */

export const DEFAULT_TIME_ZONE = 'Asia/Tokyo';
export const DEFAULT_LOCALE = 'ja-JP';

function toDate(value: string | number | Date): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 例: 2026年8月10日 19:30 */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  options: { timeZone?: string; fallback?: string } = {},
): string {
  const fallback = options.fallback ?? '—';
  if (value === null || value === undefined) {
    return fallback;
  }
  const date = toDate(value);
  if (!date) {
    return fallback;
  }
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** 例: 8/10 19:30 */
export function formatShortDateTime(
  value: string | number | Date | null | undefined,
  options: { timeZone?: string; fallback?: string } = {},
): string {
  const fallback = options.fallback ?? '—';
  if (value === null || value === undefined) {
    return fallback;
  }
  const date = toDate(value);
  if (!date) {
    return fallback;
  }
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** 例: 19:30:05 */
export function formatClockTime(
  value: string | number | Date | null | undefined,
  options: { timeZone?: string; fallback?: string; withSeconds?: boolean } = {},
): string {
  const fallback = options.fallback ?? '—';
  if (value === null || value === undefined) {
    return fallback;
  }
  const date = toDate(value);
  if (!date) {
    return fallback;
  }
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    ...(options.withSeconds === false ? {} : { second: '2-digit' }),
  }).format(date);
}

/** ミリ秒を「1分23秒」「4.5秒」のような日本語表記へ変換する。 */
export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return '—';
  }
  const ms = Math.max(0, Math.trunc(milliseconds));
  if (ms < 10_000) {
    const seconds = Math.round(ms / 100) / 10;
    return `${seconds}秒`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}秒`;
  }
  return seconds === 0 ? `${minutes}分` : `${minutes}分${seconds}秒`;
}

/** 残り秒数を「残り 12 秒」形式で表示する（カウントダウン表示用）。 */
export function formatRemainingSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return '—';
  }
  return `残り ${Math.max(0, Math.ceil(seconds))} 秒`;
}

/** 「たった今」「3分前」など、司会画面の補助表示に使う相対時刻。 */
export function formatRelativeTime(
  value: string | number | Date | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (value === null || value === undefined) {
    return '—';
  }
  const date = toDate(value);
  if (!date) {
    return '—';
  }
  const diffMs = nowMs - date.getTime();
  const absMs = Math.abs(diffMs);
  const past = diffMs >= 0;

  if (absMs < 45_000) {
    return 'たった今';
  }
  const minutes = Math.round(absMs / 60_000);
  if (minutes < 60) {
    return past ? `${minutes}分前` : `${minutes}分後`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return past ? `${hours}時間前` : `${hours}時間後`;
  }
  const days = Math.round(hours / 24);
  return past ? `${days}日前` : `${days}日後`;
}
