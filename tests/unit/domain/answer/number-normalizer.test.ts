import { describe, expect, it } from 'vitest';
import {
  NUMBER_MAX_DECIMAL_PLACES,
  NUMBER_MAX_DIGITS,
  NumberNormalizationError,
  normalizeConfiguredNumber,
  normalizeNumberAnswer,
  tryNormalizeNumberAnswer,
} from '@/domain/answer/number-normalizer';
import type { NumberNormalizationErrorCode } from '@/domain/answer/number-normalizer';

/**
 * 数値回答の正規化（仕様書 §37.1）。
 *
 * 数値は Firestore の number 型へ入れず、必ず文字列（numberRaw / numberNormalized）で扱う。
 * ここでは「正規化後の文字列」と「decimal.js の値」の両方を検証する。
 */

type AcceptedCase = readonly [label: string, input: string, expectedText: string, expected: number];
type RejectedCase = readonly [label: string, input: string, code: NumberNormalizationErrorCode];

function normalizedOf(input: string): string {
  return normalizeNumberAnswer(input).normalizedText;
}

function errorCodeOf(input: string): NumberNormalizationErrorCode {
  const result = tryNormalizeNumberAnswer(input);
  if (result.ok) {
    throw new Error(`受理されてはいけない入力が通った: ${input}`);
  }
  return result.code;
}

const ACCEPTED_CASES: readonly AcceptedCase[] = [
  ['全角数字', '３７７６', '3776', 3776],
  ['桁区切りカンマ', '1,000', '1000', 1000],
  ['全角カンマ', '１，０００', '1000', 1000],
  ['前後の空白と負号', ' -12 ', '-12', -12],
  ['全角空白の混入', '１　２', '12', 12],
  ['タブとアンダースコア', '1_0\t0', '100', 100],
  ['小数', '3.14', '3.14', 3.14],
  ['負の小数', '-0.5', '-0.5', -0.5],
  ['ゼロ', '0', '0', 0],
  ['明示的な正号', '+42', '+42', 42],
  ['小数点始まり', '.5', '.5', 0.5],
  ['前ゼロ', '007', '007', 7],
];

const REJECTED_CASES: readonly RejectedCase[] = [
  ['指数表記', '1e3', 'INVALID_NUMBER_FORMAT'],
  ['大文字の指数表記', '1E3', 'INVALID_NUMBER_FORMAT'],
  ['単位付き', '12km', 'INVALID_NUMBER_FORMAT'],
  ['全角の単位付き', '１２ｋｍ', 'INVALID_NUMBER_FORMAT'],
  ['符号の重複', '--3', 'INVALID_NUMBER_FORMAT'],
  ['末尾の小数点', '5.', 'INVALID_NUMBER_FORMAT'],
  ['小数点の重複', '1.2.3', 'INVALID_NUMBER_FORMAT'],
  ['符号が末尾', '3-', 'INVALID_NUMBER_FORMAT'],
  ['数字以外', 'abc', 'INVALID_NUMBER_FORMAT'],
  ['漢数字', '三千七百七十六', 'INVALID_NUMBER_FORMAT'],
  ['小数 11 桁', '0.11111111111', 'INVALID_NUMBER_FORMAT'],
  ['空文字', '', 'INVALID_NUMBER_LENGTH'],
  ['空白のみ', '　 \t', 'INVALID_NUMBER_LENGTH'],
  ['31 桁', '1111111111111111111111111111111', 'NUMBER_TOO_LARGE'],
];

describe('normalizeNumberAnswer（受理される入力）', () => {
  it.each(ACCEPTED_CASES)('%s: 「%s」→「%s」', (_label, input, expectedText, expected) => {
    const result = normalizeNumberAnswer(input);

    expect(result.normalizedText).toBe(expectedText);
    expect(result.decimal.toNumber()).toBe(expected);
    // 生入力は本人への表示に使うため、そのまま保持する。
    expect(result.raw).toBe(input);
  });

  it('マイナスゼロも受理する', () => {
    const result = normalizeNumberAnswer('-0');

    expect(result.normalizedText).toBe('-0');
    expect(result.decimal.isZero()).toBe(true);
  });

  it('上限ちょうどの 30 桁は受理する', () => {
    expect(normalizedOf('1'.repeat(NUMBER_MAX_DIGITS))).toBe('1'.repeat(NUMBER_MAX_DIGITS));
  });

  it('小数 10 桁ちょうどは受理する', () => {
    const input = `0.${'1'.repeat(NUMBER_MAX_DECIMAL_PLACES)}`;
    expect(normalizedOf(input)).toBe(input);
  });

  it('正規化後の値は decimal.js でそのまま扱える', () => {
    expect(normalizeNumberAnswer('３，１４１．５９').decimal.toFixed(2)).toBe('3141.59');
  });
});

describe('normalizeNumberAnswer（拒否される入力）', () => {
  it.each(REJECTED_CASES)('%s: 「%s」を拒否する', (_label, input, expectedCode) => {
    expect(errorCodeOf(input)).toBe(expectedCode);
  });

  it('桁数は 30 桁と 31 桁の境界で分かれる', () => {
    expect(() => normalizeNumberAnswer('1'.repeat(NUMBER_MAX_DIGITS))).not.toThrow();
    expect(errorCodeOf('1'.repeat(NUMBER_MAX_DIGITS + 1))).toBe('NUMBER_TOO_LARGE');
  });

  it('小数桁数は 10 桁と 11 桁の境界で分かれる', () => {
    expect(() => normalizeNumberAnswer(`0.${'1'.repeat(NUMBER_MAX_DECIMAL_PLACES)}`)).not.toThrow();
    // 正規表現が先に弾くため、コードは INVALID_NUMBER_FORMAT になる。
    expect(errorCodeOf(`0.${'1'.repeat(NUMBER_MAX_DECIMAL_PLACES + 1)}`)).toBe(
      'INVALID_NUMBER_FORMAT',
    );
  });

  it('正規化後が長すぎる入力は INVALID_NUMBER_LENGTH', () => {
    expect(errorCodeOf('9'.repeat(100))).toBe('INVALID_NUMBER_LENGTH');
  });

  it('NumberNormalizationError を投げ、code を持つ', () => {
    let caught: unknown = null;
    try {
      normalizeNumberAnswer('12km');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NumberNormalizationError);
    if (!(caught instanceof NumberNormalizationError)) {
      throw new Error('NumberNormalizationError が投げられなかった');
    }
    expect(caught.code).toBe('INVALID_NUMBER_FORMAT');
    expect(caught.name).toBe('NumberNormalizationError');
  });
});

describe('tryNormalizeNumberAnswer', () => {
  it('成功時は判別可能な結果を返す', () => {
    const result = tryNormalizeNumberAnswer('３７７６');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('成功するはずの入力が失敗した');
    }
    expect(result.value.normalizedText).toBe('3776');
  });

  it('失敗時は例外を投げずコードを返す', () => {
    const result = tryNormalizeNumberAnswer('12km');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('失敗するはずの入力が通った');
    }
    expect(result.code).toBe('INVALID_NUMBER_FORMAT');
  });
});

describe('normalizeConfiguredNumber', () => {
  it('管理画面の設定値にも参加者入力と同じ規則を適用する', () => {
    expect(normalizeConfiguredNumber('１，０００').normalizedText).toBe('1000');
    expect(() => normalizeConfiguredNumber('1e3')).toThrow(NumberNormalizationError);
  });
});
