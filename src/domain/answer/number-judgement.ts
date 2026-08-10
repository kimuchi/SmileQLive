import Decimal from 'decimal.js';
import type { NumberRule } from '@/domain/quiz/question';

/**
 * 数値問題の正誤判定。
 *
 * - 判定はすべて `decimal.js` で行う。JavaScript の `number` を使わない。
 * - 同じ規則を PostgreSQL 関数側でも `numeric` で再判定する（サーバー判定を唯一の正としない）。
 * - 範囲・許容誤差はいずれも両端を含む。
 */

export type DecimalNumberRule =
  | { mode: 'exact'; correctValue: Decimal }
  | { mode: 'absolute_tolerance'; correctValue: Decimal; tolerance: Decimal }
  | { mode: 'range'; minValue: Decimal; maxValue: Decimal };

export function toDecimalRule(rule: NumberRule): DecimalNumberRule {
  switch (rule.mode) {
    case 'exact':
      return { mode: 'exact', correctValue: new Decimal(rule.correctValue) };
    case 'absolute_tolerance':
      return {
        mode: 'absolute_tolerance',
        correctValue: new Decimal(rule.correctValue),
        tolerance: new Decimal(rule.tolerance),
      };
    case 'range':
      return {
        mode: 'range',
        minValue: new Decimal(rule.minValue),
        maxValue: new Decimal(rule.maxValue),
      };
  }
}

export function judgeNumberAnswer(answer: Decimal, rule: DecimalNumberRule): boolean {
  switch (rule.mode) {
    case 'exact':
      return answer.eq(rule.correctValue);
    case 'absolute_tolerance':
      return answer.sub(rule.correctValue).abs().lte(rule.tolerance);
    case 'range':
      return answer.gte(rule.minValue) && answer.lte(rule.maxValue);
  }
}

export function judgeNumberAnswerText(answerText: string, rule: NumberRule): boolean {
  return judgeNumberAnswer(new Decimal(answerText), toDecimalRule(rule));
}

/** 表示用の桁数へそろえる。DB 上の値は丸めず、表示だけを整形する。 */
export function formatNumberForDisplay(
  value: string | Decimal,
  decimalPlaces: number,
  options: { grouping?: boolean } = {},
): string {
  const decimal = value instanceof Decimal ? value : new Decimal(value);
  const fixed = decimal.toFixed(decimalPlaces, Decimal.ROUND_HALF_UP);
  if (options.grouping === false) {
    return fixed;
  }
  const negative = fixed.startsWith('-');
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [intPart = '0', fracPart] = unsigned.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fracPart ? `.${fracPart}` : ''}`;
}

/**
 * 投影・参加者結果画面へ出す「正解条件」の説明文。
 * 正解発表後にだけ利用する。
 */
export function describeNumberRule(
  rule: NumberRule,
  decimalPlaces: number,
  unit: string | null,
): string {
  const suffix = unit ? ` ${unit}` : '';
  switch (rule.mode) {
    case 'exact':
      return `${formatNumberForDisplay(rule.correctValue, decimalPlaces)}${suffix}`;
    case 'absolute_tolerance': {
      const center = new Decimal(rule.correctValue);
      const tolerance = new Decimal(rule.tolerance);
      const low = formatNumberForDisplay(center.sub(tolerance), decimalPlaces);
      const high = formatNumberForDisplay(center.add(tolerance), decimalPlaces);
      return `${formatNumberForDisplay(center, decimalPlaces)}${suffix} ± ${formatNumberForDisplay(
        tolerance,
        decimalPlaces,
      )}${suffix}（${low} 〜 ${high}${suffix}）`;
    }
    case 'range':
      return `${formatNumberForDisplay(rule.minValue, decimalPlaces)} 〜 ${formatNumberForDisplay(
        rule.maxValue,
        decimalPlaces,
      )}${suffix}`;
  }
}
