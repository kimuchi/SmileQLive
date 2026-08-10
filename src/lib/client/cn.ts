/**
 * className を組み立てる最小ヘルパー。
 * 追加依存を増やさないため、falsy を落として空白区切りにするだけ。
 */

export type ClassValue = string | number | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  const parts: string[] = [];
  for (const value of values) {
    if (value === false || value === null || value === undefined || value === '') {
      continue;
    }
    parts.push(String(value));
  }
  return parts.join(' ');
}
