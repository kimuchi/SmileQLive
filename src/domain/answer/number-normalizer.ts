import Decimal from 'decimal.js';

/**
 * 数値回答の正規化。
 *
 * クライアントとサーバーで同じ規則を使うが、最終判定は必ずサーバー / DB 側で行う。
 * - Unicode NFKC 正規化により全角数字を半角へ変換する
 * - 桁区切りのカンマ、アンダースコア、空白 (全角空白含む) を除去する
 * - 符号と小数点はそれぞれ 1 つだけ許可する
 * - 指数表記 (1e3) は拒否する
 * - 整数部 + 小数部の合計桁数は 30 桁まで、小数部は 10 桁まで
 */

export const NUMBER_MAX_DIGITS = 30;
export const NUMBER_MAX_DECIMAL_PLACES = 10;
/** 符号・小数点・桁数を考慮した正規化後文字列の最大長。 */
export const NUMBER_MAX_NORMALIZED_LENGTH = 42;

export type NumberNormalizationErrorCode =
  | 'INVALID_NUMBER_LENGTH'
  | 'INVALID_NUMBER_FORMAT'
  | 'NUMBER_TOO_LARGE'
  | 'NUMBER_TOO_MANY_DECIMALS';

export class NumberNormalizationError extends Error {
  readonly code: NumberNormalizationErrorCode;

  constructor(code: NumberNormalizationErrorCode) {
    super(code);
    this.name = 'NumberNormalizationError';
    this.code = code;
  }
}

export type NormalizedNumberAnswer = {
  /** 参加者が実際に入力した生文字列。結果画面で本人にだけ表示する。 */
  raw: string;
  /** 正規化後の文字列。DB の numeric へ渡す値。 */
  normalizedText: string;
  decimal: Decimal;
};

/** 空白として扱う文字（半角空白・タブ・全角空白・改行など）。 */
const WHITESPACE_AND_SEPARATORS = /[,_\s　]/g;

/**
 * 符号は先頭に 0 個または 1 個、
 * 数字列 + 任意の小数部 (最大 10 桁)、または小数点始まりの小数のみを許可する。
 */
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d{1,10})?|\.\d{1,10})$/;

export function normalizeNumberAnswer(rawInput: string): NormalizedNumberAnswer {
  const raw = rawInput;

  const normalizedText = rawInput
    .normalize('NFKC')
    .trim()
    .replace(WHITESPACE_AND_SEPARATORS, '');

  if (normalizedText.length === 0 || normalizedText.length > NUMBER_MAX_NORMALIZED_LENGTH) {
    throw new NumberNormalizationError('INVALID_NUMBER_LENGTH');
  }

  if (!NUMBER_PATTERN.test(normalizedText)) {
    throw new NumberNormalizationError('INVALID_NUMBER_FORMAT');
  }

  const digitCount = normalizedText.replace(/[^0-9]/g, '').length;
  if (digitCount > NUMBER_MAX_DIGITS) {
    throw new NumberNormalizationError('NUMBER_TOO_LARGE');
  }

  const dotIndex = normalizedText.indexOf('.');
  if (dotIndex >= 0 && normalizedText.length - dotIndex - 1 > NUMBER_MAX_DECIMAL_PLACES) {
    throw new NumberNormalizationError('NUMBER_TOO_MANY_DECIMALS');
  }

  return {
    raw,
    normalizedText,
    decimal: new Decimal(normalizedText),
  };
}

/** 例外ではなく判別可能な結果として返したい場合のラッパー。 */
export type NumberNormalizationResult =
  | { ok: true; value: NormalizedNumberAnswer }
  | { ok: false; code: NumberNormalizationErrorCode };

export function tryNormalizeNumberAnswer(rawInput: string): NumberNormalizationResult {
  try {
    return { ok: true, value: normalizeNumberAnswer(rawInput) };
  } catch (error) {
    if (error instanceof NumberNormalizationError) {
      return { ok: false, code: error.code };
    }
    return { ok: false, code: 'INVALID_NUMBER_FORMAT' };
  }
}

/**
 * 管理画面で入力された正解値・許容誤差・範囲値の検証。
 * 参加者入力と同じ正規化規則を用いる。
 */
export function normalizeConfiguredNumber(rawInput: string): NormalizedNumberAnswer {
  return normalizeNumberAnswer(rawInput);
}
