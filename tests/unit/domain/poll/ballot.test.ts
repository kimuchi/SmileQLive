import { describe, expect, it } from 'vitest';
import {
  BALLOT_STRUCTURES,
  DEFAULT_POLL_SETTINGS,
  RANK_DEPTH_MAX,
  RANK_POINTS_MAX,
  clampRankDepth,
  clampRevealDepth,
  isBallotStructure,
  normalizePoints,
  optionsOfGroup,
  pollSettingsOf,
  rankLabel,
  validateChoices,
  type PollSnapshot,
} from '@/domain/poll/ballot';

/**
 * 投票用紙。
 *
 * ここで固めたいのは「受け付けてよい票の形」。
 * 用紙に無い選択肢・同じものを 2 度・多すぎる件数は、
 * 画面で防ぐのではなくここで弾く（画面は書き換えられる）。
 */

function snapshotOf(overrides: Partial<PollSnapshot> = {}): PollSnapshot {
  return {
    ballotId: 'ballot-1',
    title: '出し物コンテスト',
    structure: 'flat',
    groups: [],
    options: [
      { id: 'a', position: 1, label: '営業部', groupId: null, note: null },
      { id: 'b', position: 2, label: '開発部', groupId: null, note: null },
      { id: 'c', position: 3, label: '総務部', groupId: null, note: null },
    ],
    settings: pollSettingsOf({ rankDepth: 3, points: [5, 3, 1] }),
    ...overrides,
  };
}

describe('選び方の種類', () => {
  it('flat と nested の 2 つだけ', () => {
    expect([...BALLOT_STRUCTURES]).toEqual(['flat', 'nested']);
  });

  it('知らない値は受け付けない', () => {
    expect(isBallotStructure('flat')).toBe(true);
    expect(isBallotStructure('nested')).toBe(true);
    expect(isBallotStructure('tree')).toBe(false);
    expect(isBallotStructure(null)).toBe(false);
  });
});

describe('順位ごとの点数', () => {
  it('rankDepth の長さにそろえる', () => {
    // 3 位まで選ぶ会に 2 つしか点数が無い → 足りない順位を埋める。
    expect(normalizePoints([5, 3], 3)).toHaveLength(3);
    // 余った点数は捨てる。
    expect(normalizePoints([5, 3, 1], 1)).toEqual([5]);
  });

  it('足りない順位は「1 位ほど高い」で埋める', () => {
    expect(normalizePoints([], 3)).toEqual([3, 2, 1]);
  });

  it('0 点も許す（順位は付けるが点は入れない使い方）', () => {
    expect(normalizePoints([1, 0, 0], 3)).toEqual([1, 0, 0]);
  });

  it('負の点数と上限超えは丸める', () => {
    expect(normalizePoints([-5, 99999], 2)).toEqual([0, RANK_POINTS_MAX]);
  });

  it('数値でない値が混ざっても既定で埋める', () => {
    expect(normalizePoints([Number.NaN, 3], 2)).toEqual([2, 3]);
  });
});

describe('設定の読み直し', () => {
  it('空の設定は既定になる', () => {
    expect(pollSettingsOf(null)).toEqual(DEFAULT_POLL_SETTINGS);
  });

  it('rankDepth を変えると点数の長さも追従する', () => {
    // 保存済みの設定を、あとから rankDepth だけ変えたときに食い違わせない。
    const settings = pollSettingsOf({ rankDepth: 3, points: [10] });
    expect(settings.points).toHaveLength(3);
    expect(settings.points[0]).toBe(10);
  });

  it('選ぶ順位と発表する順位は別に決められる', () => {
    // 3 位まで選ばせて 1 位だけ発表する会がある。
    const settings = pollSettingsOf({ rankDepth: 3, revealDepth: 1 });
    expect(settings.rankDepth).toBe(3);
    expect(settings.revealDepth).toBe(1);
  });

  it('範囲外の値は丸める', () => {
    expect(clampRankDepth(0)).toBe(1);
    expect(clampRankDepth(99)).toBe(RANK_DEPTH_MAX);
    expect(clampRevealDepth(0)).toBe(1);
    expect(clampRevealDepth(Number.NaN)).toBe(1);
  });
});

describe('1 階層目に属する選択肢', () => {
  it('flat では全件返す', () => {
    expect(optionsOfGroup(snapshotOf(), null)).toHaveLength(3);
  });

  it('nested では属するものだけ', () => {
    const snapshot = snapshotOf({
      structure: 'nested',
      groups: [
        { id: 'g1', position: 1, label: '本社' },
        { id: 'g2', position: 2, label: '支店' },
      ],
      options: [
        { id: 'a', position: 1, label: '営業部', groupId: 'g1', note: null },
        { id: 'b', position: 2, label: '開発部', groupId: 'g1', note: null },
        { id: 'c', position: 3, label: '大阪営業所', groupId: 'g2', note: null },
      ],
    });
    expect(optionsOfGroup(snapshot, 'g1').map((option) => option.id)).toEqual(['a', 'b']);
    expect(optionsOfGroup(snapshot, 'g2').map((option) => option.id)).toEqual(['c']);
  });
});

describe('受け付けてよい票か', () => {
  it('順位ぶんまでなら受け付ける', () => {
    expect(validateChoices(snapshotOf(), ['a'])).toEqual({ ok: true });
    expect(validateChoices(snapshotOf(), ['a', 'b', 'c'])).toEqual({ ok: true });
  });

  it('空の票は受け付けない', () => {
    expect(validateChoices(snapshotOf(), [])).toEqual({ ok: false, reason: 'empty' });
  });

  it('順位より多い票は受け付けない', () => {
    // 1 位だけ選ぶ会へ 2 件送られたら、どちらを 1 位にするか決められない。
    const snapshot = snapshotOf({ settings: pollSettingsOf({ rankDepth: 1 }) });
    expect(validateChoices(snapshot, ['a', 'b'])).toEqual({ ok: false, reason: 'too_many' });
  });

  it('同じものを 2 つの順位へは入れられない', () => {
    // 1 位も 2 位も同じ人、は数えようがない。
    expect(validateChoices(snapshotOf(), ['a', 'a'])).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('用紙に無い選択肢は受け付けない', () => {
    expect(validateChoices(snapshotOf(), ['zzz'])).toEqual({
      ok: false,
      reason: 'unknown_option',
    });
  });

  it('2 段階でどこにも属していない選択肢は選べない', () => {
    const snapshot = snapshotOf({
      structure: 'nested',
      groups: [{ id: 'g1', position: 1, label: '本社' }],
      options: [
        { id: 'a', position: 1, label: '営業部', groupId: 'g1', note: null },
        { id: 'orphan', position: 2, label: '宙に浮いた選択肢', groupId: null, note: null },
      ],
    });
    expect(validateChoices(snapshot, ['orphan'])).toEqual({ ok: false, reason: 'orphan_option' });
  });
});

describe('順位の呼び名', () => {
  it('n位', () => {
    expect(rankLabel(1)).toBe('1位');
    expect(rankLabel(3)).toBe('3位');
  });
});
