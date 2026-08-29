import { describe, expect, it } from 'vitest';
import { pollSettingsOf } from '@/domain/poll/ballot';
import {
  emptyTally,
  groupByRank,
  isRevealed,
  normalizeTally,
  rankOptions,
  revealComplete,
  revealOrder,
  scoreOf,
  tallyVotes,
} from '@/domain/poll/tally';

/**
 * 投票の集計。
 *
 * ここで固めたいのは 3 つ。
 *   1. 点数は**票数から計算する**。司会が直すのは票数だけ。
 *   2. **同点は同じ順位**。片方だけ下に出すと会場で揉める。
 *   3. 発表は**下の順位から**。1 位から出すと後を誰も見ない。
 */

const IDS = ['a', 'b', 'c'];

describe('票数から点数を出す', () => {
  it('順位ごとの重みを掛けて足す', () => {
    // 1 位票 2 つ・2 位票 1 つ、点数 5/3/1 → 5*2 + 3*1 = 13
    expect(scoreOf([2, 1, 0], [5, 3, 1])).toBe(13);
  });

  it('点数の指定が足りない順位は 0 点として扱う', () => {
    expect(scoreOf([1, 1], [5])).toBe(5);
  });
});

describe('投票の記録から集計を作る', () => {
  it('選んだ順に順位ごとの票を数える', () => {
    const tally = tallyVotes(IDS, 3, [
      ['a', 'b', 'c'],
      ['a', 'c', 'b'],
      ['b', 'a', 'c'],
    ]);
    expect(tally.voterCount).toBe(3);
    expect(tally.entries.find((entry) => entry.optionId === 'a')?.counts).toEqual([2, 1, 0]);
    expect(tally.entries.find((entry) => entry.optionId === 'b')?.counts).toEqual([1, 1, 1]);
    expect(tally.entries.find((entry) => entry.optionId === 'c')?.counts).toEqual([0, 1, 2]);
  });

  it('1 票も入っていない選択肢も並べる', () => {
    // 0 票の選択肢を落とすと、司会が「入れ忘れ」と区別できない。
    const tally = tallyVotes(IDS, 1, [['a']]);
    expect(tally.entries.map((entry) => entry.optionId)).toEqual(IDS);
    expect(tally.entries.find((entry) => entry.optionId === 'c')?.counts).toEqual([0]);
  });

  it('用紙に無い選択肢は捨てる', () => {
    // 用紙を差し替えた古い票が混ざっても、集計を壊さない。
    const tally = tallyVotes(IDS, 1, [['zzz'], ['a']]);
    expect(tally.voterCount).toBe(2);
    expect(tally.entries.find((entry) => entry.optionId === 'a')?.counts).toEqual([1]);
  });

  it('順位より長い票は溢れた分を捨てる', () => {
    const tally = tallyVotes(IDS, 1, [['a', 'b']]);
    expect(tally.entries.find((entry) => entry.optionId === 'b')?.counts).toEqual([0]);
  });

  it('空の集計は全選択肢 0 票', () => {
    expect(emptyTally(IDS, 2)).toEqual({
      voterCount: 0,
      entries: [
        { optionId: 'a', counts: [0, 0] },
        { optionId: 'b', counts: [0, 0] },
        { optionId: 'c', counts: [0, 0] },
      ],
    });
  });
});

describe('保存済みの集計を読み直す', () => {
  it('順位の数が変わっても長さをそろえる', () => {
    const stored = { voterCount: 4, entries: [{ optionId: 'a', counts: [4] }] };
    const read = normalizeTally(stored, IDS, 3);
    expect(read.entries.find((entry) => entry.optionId === 'a')?.counts).toEqual([4, 0, 0]);
    expect(read.entries).toHaveLength(3);
  });

  it('負の票数と小数は丸める', () => {
    const stored = { voterCount: -3, entries: [{ optionId: 'a', counts: [-1, 2.6] }] };
    const read = normalizeTally(stored, IDS, 2);
    expect(read.voterCount).toBe(0);
    expect(read.entries[0]?.counts).toEqual([0, 3]);
  });

  it('集計が無ければ全部 0 票', () => {
    expect(normalizeTally(null, IDS, 1).entries.map((entry) => entry.counts)).toEqual([
      [0],
      [0],
      [0],
    ]);
  });
});

describe('順位を付ける', () => {
  const settings = pollSettingsOf({ rankDepth: 3, points: [5, 3, 1] });

  it('点数の高い順に並ぶ', () => {
    const tally = tallyVotes(IDS, 3, [
      ['b', 'a', 'c'],
      ['b', 'c', 'a'],
      ['a', 'b', 'c'],
    ]);
    const ranked = rankOptions(tally, IDS, settings);
    expect(ranked.map((entry) => entry.optionId)).toEqual(['b', 'a', 'c']);
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 2, 3]);
  });

  it('同点は 1 位票の多い順で決める', () => {
    // 点数 1/1/1、a は 1 位票 2 つ、b は 1 位票 0（2 位票 6 つ）。
    const settings1 = pollSettingsOf({ rankDepth: 2, points: [1, 1] });
    const tally = {
      voterCount: 8,
      entries: [
        { optionId: 'a', counts: [2, 4] },
        { optionId: 'b', counts: [0, 6] },
        { optionId: 'c', counts: [0, 0] },
      ],
    };
    const ranked = rankOptions(tally, IDS, settings1);
    expect(ranked.map((entry) => entry.optionId)).toEqual(['a', 'b', 'c']);
  });

  it('同点は同じ順位になり、次の順位まで飛ぶ', () => {
    // 会場で「同点なのに片方だけ 2 位」と出すと、あとで揉める。
    const tally = {
      voterCount: 2,
      entries: [
        { optionId: 'a', counts: [1, 0, 0] },
        { optionId: 'b', counts: [1, 0, 0] },
        { optionId: 'c', counts: [0, 0, 0] },
      ],
    };
    const ranked = rankOptions(tally, IDS, settings);
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 1, 3]);
  });

  it('票も点も同じなら用紙の並び順', () => {
    const tally = emptyTally(IDS, 3);
    const ranked = rankOptions(tally, IDS, settings);
    expect(ranked.map((entry) => entry.optionId)).toEqual(['a', 'b', 'c']);
  });

  it('総得票数は順位を問わず数える', () => {
    const tally = { voterCount: 3, entries: [{ optionId: 'a', counts: [1, 2, 0] }] };
    const ranked = rankOptions(tally, ['a'], settings);
    expect(ranked[0]?.totalVotes).toBe(3);
  });
});

describe('発表の順番', () => {
  it('下の順位から出す', () => {
    // 1 位から出すと、そのあとの発表を誰も見ない。
    expect(revealOrder(3)).toEqual([3, 2, 1]);
    expect(revealOrder(1)).toEqual([1]);
  });

  it('押した回数ぶんだけ下から見せる', () => {
    // 3 位まで発表する会。1 回押した時点で 3 位だけ。
    expect(isRevealed(3, 3, 1)).toBe(true);
    expect(isRevealed(2, 3, 1)).toBe(false);
    expect(isRevealed(1, 3, 1)).toBe(false);

    expect(isRevealed(2, 3, 2)).toBe(true);
    expect(isRevealed(1, 3, 3)).toBe(true);
  });

  it('まだ 1 回も押していなければ何も見せない', () => {
    for (const rank of [1, 2, 3]) {
      expect(isRevealed(rank, 3, 0)).toBe(false);
    }
  });

  it('発表しない順位は押し続けても出ない', () => {
    // 3 位まで発表する会で 4 位は出さない。
    expect(isRevealed(4, 3, 3)).toBe(false);
  });

  it('出しきったかどうか', () => {
    expect(revealComplete(3, 2)).toBe(false);
    expect(revealComplete(3, 3)).toBe(true);
    expect(revealComplete(1, 1)).toBe(true);
  });
});

describe('順位ごとのまとまり', () => {
  it('同点は 1 つの順位にまとめる', () => {
    const ranked = [
      { optionId: 'a', rank: 1, score: 5, counts: [1], totalVotes: 1 },
      { optionId: 'b', rank: 1, score: 5, counts: [1], totalVotes: 1 },
      { optionId: 'c', rank: 3, score: 0, counts: [0], totalVotes: 0 },
    ];
    const groups = groupByRank(ranked, 3);
    expect(groups.map((group) => group.rank)).toEqual([1, 3]);
    expect(groups[0]?.options).toHaveLength(2);
  });

  it('発表しない順位は入らない', () => {
    const ranked = [
      { optionId: 'a', rank: 1, score: 5, counts: [1], totalVotes: 1 },
      { optionId: 'b', rank: 2, score: 3, counts: [1], totalVotes: 1 },
    ];
    expect(groupByRank(ranked, 1).map((group) => group.rank)).toEqual([1]);
  });
});
