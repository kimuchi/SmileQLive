import { describe, expect, it } from 'vitest';
import { FREQUENT_VALUES_LIMIT, summarizeFrequentValues } from '@/domain/answer/answer-dto';

/**
 * 数値回答の代表値集計（仕様書 §37.1）。
 *
 * - 出現回数の多い順に上位 5 件。
 * - 同数のときは数値として昇順（文字列比較にしない）。
 * - 集計対象は正規化済み文字列。number へ変換して保持しない。
 */

describe('summarizeFrequentValues', () => {
  it('出現回数の多い順に返す', () => {
    expect(summarizeFrequentValues(['10', '10', '10', '20', '20', '30'])).toEqual([
      { value: '10', count: 3 },
      { value: '20', count: 2 },
      { value: '30', count: 1 },
    ]);
  });

  it('同数のときは数値として昇順に並べる', () => {
    expect(summarizeFrequentValues(['10', '10', '2', '2', '3', '3'])).toEqual([
      { value: '2', count: 2 },
      { value: '3', count: 2 },
      { value: '10', count: 2 },
    ]);
  });

  it('同数の並び順は文字列比較ではない（100 が 9 より後になる）', () => {
    const result = summarizeFrequentValues(['100', '100', '9', '9']);

    expect(result.map((r) => r.value)).toEqual(['9', '100']);
  });

  it('負数・小数も数値として昇順に並べる', () => {
    const result = summarizeFrequentValues(['0.5', '-3', '-10', '2']);

    expect(result.map((r) => r.value)).toEqual(['-10', '-3', '0.5', '2']);
  });

  it('既定では上位 5 件までに絞る', () => {
    expect(FREQUENT_VALUES_LIMIT).toBe(5);

    const values = [
      '1',
      '2',
      '2',
      '3',
      '3',
      '3',
      '4',
      '4',
      '4',
      '4',
      '5',
      '5',
      '5',
      '5',
      '5',
      '6',
      '6',
      '6',
      '6',
      '6',
      '6',
    ];
    const result = summarizeFrequentValues(values);

    expect(result).toHaveLength(5);
    expect(result).toEqual([
      { value: '6', count: 6 },
      { value: '5', count: 5 },
      { value: '4', count: 4 },
      { value: '3', count: 3 },
      { value: '2', count: 2 },
    ]);
  });

  it('件数を指定できる', () => {
    expect(summarizeFrequentValues(['1', '1', '2', '3'], 2)).toEqual([
      { value: '1', count: 2 },
      { value: '2', count: 1 },
    ]);
  });

  it('回答が無ければ空配列', () => {
    expect(summarizeFrequentValues([])).toEqual([]);
  });

  it('同じ値を数え上げる（正規化済み文字列をキーにする）', () => {
    // 正規化済みなので「1000」と「1,000」は同じ文字列として届く前提。
    expect(summarizeFrequentValues(['1000', '1000', '1000'])).toEqual([
      { value: '1000', count: 3 },
    ]);
  });

  it('表記が違えば別の値として数える（正規化はここで行わない）', () => {
    const result = summarizeFrequentValues(['1.0', '1']);

    expect(result).toHaveLength(2);
  });

  it('上限 0 なら空配列', () => {
    expect(summarizeFrequentValues(['1', '2'], 0)).toEqual([]);
  });
});
