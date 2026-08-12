/**
 * 人数・割合・順位の日本語表示ヘルパー。
 *
 * 数値問題の正解値など「判定に関わる数値」はここで整形しない。
 * それらは decimal.js を使う `formatNumberForDisplay()` を利用すること。
 */

export const DEFAULT_LOCALE = 'ja-JP';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 桁区切り付きの整数表示。例: 1,234 */
export function formatInteger(value: number | null | undefined, fallback = '—'): string {
  if (!isFiniteNumber(value)) {
    return fallback;
  }
  return new Intl.NumberFormat(DEFAULT_LOCALE, { maximumFractionDigits: 0 }).format(
    Math.trunc(value),
  );
}

/**
 * 件数表示。例: formatCount(12) → 「12人」 / formatCount(3, '問') → 「3問」
 */
export function formatCount(value: number | null | undefined, unit = '人', fallback = '—'): string {
  if (!isFiniteNumber(value)) {
    return fallback;
  }
  return `${formatInteger(value)}${unit}`;
}

/** 「12 / 200人」形式。回答進捗の表示に使う。 */
export function formatRatioCount(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
  unit = '人',
): string {
  if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator)) {
    return '—';
  }
  return `${formatInteger(numerator)} / ${formatInteger(denominator)}${unit}`;
}

/**
 * 0〜1 の割合をパーセント表示へ変換する。例: percent(0.427) → 「43%」
 * 既に 0〜100 のパーセント値を渡す場合は `{ alreadyPercent: true }` を指定する。
 */
export function percent(
  value: number | null | undefined,
  options: { fractionDigits?: number; alreadyPercent?: boolean; fallback?: string } = {},
): string {
  const fallback = options.fallback ?? '—';
  if (!isFiniteNumber(value)) {
    return fallback;
  }
  const ratio = options.alreadyPercent ? value / 100 : value;
  const digits = options.fractionDigits ?? 0;
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(ratio);
}

/** 分子・分母から割合を求める（分母 0 のときは 0）。表示ではなく計算用。 */
export function safeRatio(numerator: number, denominator: number): number {
  if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator) || denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

/** 順位表示。例: formatRank(1) → 「1位」 */
export function formatRank(rank: number | null | undefined, fallback = '—'): string {
  if (!isFiniteNumber(rank) || rank <= 0) {
    return fallback;
  }
  return `${formatInteger(rank)}位`;
}

/** 得点表示。例: formatPoints(1200) → 「1,200点」 */
export function formatPoints(points: number | null | undefined, fallback = '—'): string {
  if (!isFiniteNumber(points)) {
    return fallback;
  }
  return `${formatInteger(points)}点`;
}

/** 「第3問 / 全10問」形式。 */
export function formatQuestionProgress(
  position: number | null | undefined,
  total: number | null | undefined,
  /** 全問数を出すか。クイズ設定で切り替えられる（既定は出す）。 */
  options: { showTotal?: boolean } = {},
): string {
  if (!isFiniteNumber(position)) {
    return '—';
  }
  if (options.showTotal === false) {
    return `第${formatInteger(position)}問`;
  }
  if (!isFiniteNumber(total)) {
    return '—';
  }
  return `第${formatInteger(position)}問 / 全${formatInteger(total)}問`;
}

/** バイト数の日本語表示。管理画面の画像一覧などに使う。 */
export function formatByteSize(bytes: number | null | undefined): string {
  if (!isFiniteNumber(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
