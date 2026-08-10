import 'server-only';

/**
 * PostgREST から返る行を安全に読むための小さなユーティリティ。
 *
 * なぜ必要か:
 * - `numeric` カラムは PostgREST が JSON 数値として返すため、
 *   そのまま JSON.parse すると倍精度浮動小数点へ丸められて桁落ちする。
 *   そこで select では `column::text` へキャストし、ここでは**文字列のまま**取り出す。
 * - `noUncheckedIndexedAccess` 下でインデックスアクセスを安全に扱う。
 *
 * any は使わず unknown からの絞り込みで型を確定させる。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

export function readString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

export function requireString(row: Record<string, unknown>, key: string): string {
  const value = readString(row, key);
  if (value === null) {
    throw new Error(`MISSING_STRING_COLUMN: ${key}`);
  }
  return value;
}

export function readInt(row: Record<string, unknown>, key: string, fallback: number): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function readBoolean(row: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = row[key];
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * numeric カラムを**文字列のまま**取り出す。
 * select 側で `::text` へキャストしていることを前提とするが、
 * 万一数値で返っても String() で文字列化し、number のまま扱わない。
 */
export function readNumericText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/** 列挙値を許容リストで絞り込む。 */
export function readEnum<T extends string>(
  row: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = row[key];
  if (typeof value !== 'string') {
    return null;
  }
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** 配列カラム（埋め込みリレーション）を読む。 */
export function readRecordArray(
  row: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  return asRecordArray(row[key]);
}
