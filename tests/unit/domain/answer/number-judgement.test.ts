import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  describeNumberRule,
  formatNumberForDisplay,
  judgeNumberAnswer,
  judgeNumberAnswerText,
  toDecimalRule,
} from '@/domain/answer/number-judgement';
import type { NumberRule } from '@/domain/quiz/question';
import { normalizeNumberAnswer } from '@/domain/answer/number-normalizer';

/**
 * 数値問題の正誤判定（仕様書 §37.1）。
 *
 * 判定は decimal.js のみで行う。JavaScript の number を経由すると
 * 0.1 + 0.2 !== 0.3 のような誤判定が起きるため、境界値を厚めに検証する。
 */

const EXACT: NumberRule = { mode: 'exact', correctValue: '100' };
/** 100 ± 2 → 98 〜 102 を正解とする。 */
const TOLERANCE: NumberRule = { mode: 'absolute_tolerance', correctValue: '100', tolerance: '2' };
/** 9.5 〜 10.5 を正解とする。 */
const RANGE: NumberRule = { mode: 'range', minValue: '9.5', maxValue: '10.5' };

/** 参加者入力と同じ経路（正規化 → decimal）で判定する。 */
function judgeInput(input: string, rule: NumberRule): boolean {
  return judgeNumberAnswer(normalizeNumberAnswer(input).decimal, toDecimalRule(rule));
}

describe('judgeNumberAnswer: exact', () => {
  it.each([
    ['100', true],
    ['100.0', true],
    ['100.0000000000', true],
    ['+100', true],
    ['１００', true],
    ['99.9999999999', false],
    ['100.0000000001', false],
    ['-100', false],
  ] as const)('「%s」→ %s', (input, expected) => {
    expect(judgeInput(input, EXACT)).toBe(expected);
  });
});

describe('judgeNumberAnswer: absolute_tolerance（100 ± 2）', () => {
  it('境界の 98 と 102 は正解（両端を含む）', () => {
    expect(judgeInput('98', TOLERANCE)).toBe(true);
    expect(judgeInput('102', TOLERANCE)).toBe(true);
  });

  it('境界のわずか外側 97.999 と 102.001 は不正解', () => {
    expect(judgeInput('97.999', TOLERANCE)).toBe(false);
    expect(judgeInput('102.001', TOLERANCE)).toBe(false);
  });

  it('中央値と内側は正解', () => {
    expect(judgeInput('100', TOLERANCE)).toBe(true);
    expect(judgeInput('99.5', TOLERANCE)).toBe(true);
    expect(judgeInput('101.9999999999', TOLERANCE)).toBe(true);
  });

  it('tolerance 0 は完全一致と同義', () => {
    const zero: NumberRule = { mode: 'absolute_tolerance', correctValue: '100', tolerance: '0' };

    expect(judgeInput('100', zero)).toBe(true);
    expect(judgeInput('100.0000000001', zero)).toBe(false);
  });

  it('負の正解値でも絶対値で判定する', () => {
    const negative: NumberRule = {
      mode: 'absolute_tolerance',
      correctValue: '-10',
      tolerance: '0.5',
    };

    expect(judgeInput('-10.5', negative)).toBe(true);
    expect(judgeInput('-9.5', negative)).toBe(true);
    expect(judgeInput('-10.51', negative)).toBe(false);
  });
});

describe('judgeNumberAnswer: range（9.5 〜 10.5）', () => {
  it('両端の 9.5 と 10.5 は正解', () => {
    expect(judgeInput('9.5', RANGE)).toBe(true);
    expect(judgeInput('10.5', RANGE)).toBe(true);
  });

  it('10.51 は不正解', () => {
    expect(judgeInput('10.51', RANGE)).toBe(false);
  });

  it('9.49 は不正解', () => {
    expect(judgeInput('9.49', RANGE)).toBe(false);
  });

  it('範囲の内側は正解', () => {
    expect(judgeInput('10', RANGE)).toBe(true);
    expect(judgeInput('9.500000001', RANGE)).toBe(true);
    expect(judgeInput('10.4999999999', RANGE)).toBe(true);
  });
});

describe('浮動小数点の誤判定が起きないこと', () => {
  it('JavaScript の number では 0.1 + 0.2 は 0.3 にならない（前提の確認）', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('decimal.js なら 0.1 + 0.2 は 0.3 と完全一致する', () => {
    const answer = new Decimal('0.1').plus('0.2');

    expect(answer.eq(new Decimal('0.3'))).toBe(true);
    expect(judgeNumberAnswer(answer, toDecimalRule({ mode: 'exact', correctValue: '0.3' }))).toBe(
      true,
    );
  });

  it('浮動小数点の誤差相当値を文字列で受けても正しく判定する', () => {
    // number 経由で作ると 0.30000000000000004 になる値。
    expect(
      judgeNumberAnswerText('0.30000000000000004', { mode: 'exact', correctValue: '0.3' }),
    ).toBe(false);
    expect(judgeNumberAnswerText('0.3', { mode: 'exact', correctValue: '0.30' })).toBe(true);
  });

  it('0.1 + 0.2 の和が許容誤差 0 の判定を通る', () => {
    const rule: NumberRule = {
      mode: 'absolute_tolerance',
      correctValue: '0.3',
      tolerance: '0',
    };

    expect(judgeNumberAnswer(new Decimal('0.1').plus('0.2'), toDecimalRule(rule))).toBe(true);
  });

  it('大きな桁数でも精度を失わない', () => {
    const rule: NumberRule = { mode: 'exact', correctValue: '123456789012345678901234567890' };

    expect(judgeNumberAnswerText('123456789012345678901234567890', rule)).toBe(true);
    expect(judgeNumberAnswerText('123456789012345678901234567891', rule)).toBe(false);
  });
});

describe('toDecimalRule', () => {
  it('文字列の規則を Decimal へ変換する', () => {
    const exact = toDecimalRule(EXACT);
    expect(exact.mode).toBe('exact');
    if (exact.mode !== 'exact') {
      throw new Error('exact として変換されていない');
    }
    expect(exact.correctValue.toString()).toBe('100');

    const range = toDecimalRule(RANGE);
    if (range.mode !== 'range') {
      throw new Error('range として変換されていない');
    }
    expect(range.minValue.toString()).toBe('9.5');
    expect(range.maxValue.toString()).toBe('10.5');
  });
});

describe('formatNumberForDisplay', () => {
  it('既定では 3 桁区切りを付ける', () => {
    expect(formatNumberForDisplay('1234567.891', 2)).toBe('1,234,567.89');
  });

  it('grouping: false なら区切りを付けない', () => {
    expect(formatNumberForDisplay('1234567.891', 2, { grouping: false })).toBe('1234567.89');
  });

  it('指定桁数へゼロ詰めする', () => {
    expect(formatNumberForDisplay('0.5', 2)).toBe('0.50');
    expect(formatNumberForDisplay('3776', 0)).toBe('3,776');
  });

  it('四捨五入（ROUND_HALF_UP）で丸める', () => {
    expect(formatNumberForDisplay('1234.5', 0)).toBe('1,235');
    expect(formatNumberForDisplay('1234.4', 0)).toBe('1,234');
    expect(formatNumberForDisplay('-1234.5', 0)).toBe('-1,235');
  });

  it('負数の符号は区切りの外に置く', () => {
    expect(formatNumberForDisplay('-1234567.891', 2)).toBe('-1,234,567.89');
  });

  it('Decimal をそのまま渡せる', () => {
    expect(formatNumberForDisplay(new Decimal('9.5'), 1)).toBe('9.5');
  });

  it('4 桁未満には区切りを入れない', () => {
    expect(formatNumberForDisplay('999', 0)).toBe('999');
    expect(formatNumberForDisplay('1000', 0)).toBe('1,000');
  });
});

describe('describeNumberRule', () => {
  it('exact は正解値のみを示す', () => {
    expect(describeNumberRule(EXACT, 0, 'km')).toBe('100 km');
    expect(describeNumberRule(EXACT, 1, null)).toBe('100.0');
  });

  it('absolute_tolerance は許容範囲も併記する', () => {
    expect(describeNumberRule(TOLERANCE, 0, null)).toBe('100 ± 2（98 〜 102）');
    expect(describeNumberRule(TOLERANCE, 0, 'm')).toBe('100 m ± 2 m（98 〜 102 m）');
  });

  it('range は下限と上限を示す', () => {
    expect(describeNumberRule(RANGE, 1, 'm')).toBe('9.5 〜 10.5 m');
    expect(describeNumberRule(RANGE, 1, null)).toBe('9.5 〜 10.5');
  });

  it('説明文に使う値は判定境界と一致する', () => {
    // 表示された 98 / 102 が実際に正解になることを確認する。
    expect(describeNumberRule(TOLERANCE, 0, null)).toContain('98 〜 102');
    expect(judgeInput('98', TOLERANCE)).toBe(true);
    expect(judgeInput('102', TOLERANCE)).toBe(true);
  });
});
