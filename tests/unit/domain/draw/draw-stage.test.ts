import { describe, expect, it } from 'vitest';
import {
  BINGO_COLUMN_LABELS,
  bingoColumns,
  drawnEntryIdSet,
  drawnStageEntries,
  latestStageEntry,
  remainingStageEntries,
  type StageDraw,
  type StageDrawEntry,
} from '@/domain/draw/draw-stage';
import { DEFAULT_DRAW_SETTINGS } from '@/domain/draw/draw-list';

/**
 * 投影へ渡す抽選の状態。
 *
 * 「もう出た球」と「まだ出ていない球」を取り違えると、
 * 会場のビンゴが成立しなくなる。ここを固める。
 */

function entry(id: string, position: number, label: string): StageDrawEntry {
  return { id, position, label, image: null };
}

function makeDraw(overrides: Partial<StageDraw> = {}): StageDraw {
  const entries = [entry('a', 1, '山田'), entry('b', 2, '田中'), entry('c', 3, '佐藤')];
  return {
    title: '抽選',
    kind: 'name',
    settings: DEFAULT_DRAW_SETTINGS,
    entries,
    drawn: [],
    latestEntryId: null,
    latestOrder: null,
    remainingCount: entries.length,
    numberRange: null,
    background: null,
    ...overrides,
  };
}

/** 数字ビンゴの状態を作る。 */
function makeNumberDraw(min: number, max: number, drawnLabels: string[] = []): StageDraw {
  const entries = Array.from({ length: max - min + 1 }, (_, index) =>
    entry(`n${min + index}`, index + 1, String(min + index)),
  );
  const drawn = drawnLabels.map((label, index) => ({ order: index + 1, entryId: `n${label}` }));
  const last = drawn.length > 0 ? drawn[drawn.length - 1] : null;
  return {
    title: 'ビンゴ',
    kind: 'number',
    settings: DEFAULT_DRAW_SETTINGS,
    entries,
    drawn,
    latestEntryId: last?.entryId ?? null,
    latestOrder: last?.order ?? null,
    remainingCount: entries.length - drawn.length,
    numberRange: { min, max },
    background: null,
  };
}

describe('引いたもの・残っているもの', () => {
  it('引いた順に並べる（保存の順番に左右されない）', () => {
    const draw = makeDraw({
      drawn: [
        { order: 2, entryId: 'c' },
        { order: 1, entryId: 'a' },
      ],
    });

    expect(drawnStageEntries(draw).map((e) => e.label)).toEqual(['山田', '佐藤']);
  });

  it('残りは引いたものを除いたもの', () => {
    const draw = makeDraw({ drawn: [{ order: 1, entryId: 'b' }] });

    expect(remainingStageEntries(draw).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('直近に引いたものを返す', () => {
    const draw = makeDraw({
      drawn: [
        { order: 1, entryId: 'a' },
        { order: 2, entryId: 'c' },
      ],
      latestEntryId: 'c',
      latestOrder: 2,
    });

    expect(latestStageEntry(draw)?.label).toBe('佐藤');
    expect(latestStageEntry(draw)?.order).toBe(2);
  });

  it('まだ引いていなければ直近は無い', () => {
    expect(latestStageEntry(makeDraw())).toBeNull();
  });

  it('リストに無い id を指していても壊れない', () => {
    // ルームの抽選リストを差し替えたときなど。画面を落とさない。
    const draw = makeDraw({ latestEntryId: 'missing', latestOrder: 1 });

    expect(latestStageEntry(draw)).toBeNull();
  });

  it('出た球の集合を返す', () => {
    const draw = makeDraw({
      drawn: [
        { order: 1, entryId: 'a' },
        { order: 2, entryId: 'c' },
      ],
    });
    const set = drawnEntryIdSet(draw);

    expect(set.has('a')).toBe(true);
    expect(set.has('b')).toBe(false);
    expect(set.has('c')).toBe(true);
  });
});

describe('ビンゴのボードの列分け', () => {
  it('1〜75 は B/I/N/G/O の 5 列 × 15 個になる', () => {
    const columns = bingoColumns(makeNumberDraw(1, 75));

    expect(columns).toHaveLength(5);
    expect(columns.map((column) => column.label)).toEqual([...BINGO_COLUMN_LABELS]);
    expect(columns.every((column) => column.entries.length === 15)).toBe(true);
    // 列の中身は連番で並ぶ（B が 1〜15、I が 16〜30…）。
    expect(columns[0]?.entries[0]?.label).toBe('1');
    expect(columns[1]?.entries[0]?.label).toBe('16');
    expect(columns[4]?.entries.at(-1)?.label).toBe('75');
  });

  it('5 列に収まらない範囲では見出しを出さない', () => {
    // B/I/N/G/O は 1〜75 の慣習。範囲が違うのに見出しだけ出すと嘘になる。
    const columns = bingoColumns(makeNumberDraw(1, 20));

    expect(columns.every((column) => column.label === null)).toBe(true);
  });

  it('全部の球が必ずどれかの列に入る（1 つも落とさない）', () => {
    for (const [min, max] of [
      [1, 75],
      [1, 20],
      [1, 99],
      [10, 40],
      [1, 5],
    ] as const) {
      const draw = makeNumberDraw(min, max);
      const flat = bingoColumns(draw).flatMap((column) => column.entries);

      expect(flat.map((e) => e.id)).toEqual(draw.entries.map((e) => e.id));
    }
  });

  it('数字でないリストは 1 列にまとめる', () => {
    const columns = bingoColumns(makeDraw({ kind: 'item' }));

    expect(columns).toHaveLength(1);
    expect(columns[0]?.label).toBeNull();
  });

  it('空の列を作らない', () => {
    const columns = bingoColumns(makeNumberDraw(1, 3));

    expect(columns.every((column) => column.entries.length > 0)).toBe(true);
  });
});
