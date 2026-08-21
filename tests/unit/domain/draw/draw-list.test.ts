import { describe, expect, it } from 'vitest';
import {
  DRAW_ENTRY_MAX_COUNT,
  buildNumberEntries,
  drawnEntries,
  latestDraw,
  remainingEntries,
  type DrawEntry,
  type DrawRecord,
} from '@/domain/draw/draw-list';
import { ROOM_MODES, acceptsParticipants, isDrawMode, roomModeOf } from '@/domain/room/room-mode';

/**
 * 抽選リストの計算。
 *
 * 「もう出たものを二度出さない」「引いた順が当選順位になる」という、
 * 会場でやり直しの効かない部分をここで固める。
 */

function entry(id: string, position: number, label: string): DrawEntry {
  return { id, position, label, image: null };
}

describe('数字の展開', () => {
  it('範囲から連番を作る', () => {
    const entries = buildNumberEntries(1, 5);

    expect(entries.map((e) => e.label)).toEqual(['1', '2', '3', '4', '5']);
    expect(entries.map((e) => e.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ビンゴの 1〜75 を作れる', () => {
    expect(buildNumberEntries(1, 75)).toHaveLength(75);
  });

  it('1 から始まらない範囲も作れる', () => {
    const entries = buildNumberEntries(100, 102);

    expect(entries.map((e) => e.label)).toEqual(['100', '101', '102']);
    // 並び順は 1 始まり。数字そのものとは別に持つ。
    expect(entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it('id は数字ごとに決まる（引き直しても同じものを指す）', () => {
    expect(buildNumberEntries(1, 3).map((e) => e.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('逆さまの範囲・整数でない値は受け付けない', () => {
    expect(() => buildNumberEntries(10, 1)).toThrow();
    expect(() => buildNumberEntries(1.5, 10)).toThrow();
    expect(() => buildNumberEntries(0, 10)).toThrow();
  });

  it('広すぎる範囲は受け付けない', () => {
    expect(() => buildNumberEntries(1, DRAW_ENTRY_MAX_COUNT + 1)).toThrow();
  });
});

describe('残りと履歴', () => {
  const entries = [entry('a', 1, '山田'), entry('b', 2, '田中'), entry('c', 3, '佐藤')];

  it('引いたものは残りから消える', () => {
    const drawn: DrawRecord[] = [{ order: 1, entryId: 'b' }];

    expect(remainingEntries(entries, drawn).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('全部引いたら残りは空', () => {
    const drawn: DrawRecord[] = [
      { order: 1, entryId: 'a' },
      { order: 2, entryId: 'b' },
      { order: 3, entryId: 'c' },
    ];

    expect(remainingEntries(entries, drawn)).toEqual([]);
  });

  it('履歴は引いた順に並ぶ（保存の順番に左右されない）', () => {
    const drawn: DrawRecord[] = [
      { order: 3, entryId: 'c' },
      { order: 1, entryId: 'a' },
      { order: 2, entryId: 'b' },
    ];

    expect(drawnEntries(entries, drawn).map((e) => e.label)).toEqual(['山田', '田中', '佐藤']);
    expect(drawnEntries(entries, drawn).map((e) => e.order)).toEqual([1, 2, 3]);
  });

  it('リストに無い id は履歴から落とす（画面を壊さない）', () => {
    const drawn: DrawRecord[] = [
      { order: 1, entryId: 'a' },
      { order: 2, entryId: 'missing' },
    ];

    expect(drawnEntries(entries, drawn).map((e) => e.id)).toEqual(['a']);
  });

  it('直近に引いたものを返す', () => {
    const drawn: DrawRecord[] = [
      { order: 1, entryId: 'a' },
      { order: 2, entryId: 'c' },
    ];

    expect(latestDraw(entries, drawn)?.label).toBe('佐藤');
    expect(latestDraw(entries, drawn)?.order).toBe(2);
  });

  it('1 件も引いていなければ直近は無い', () => {
    expect(latestDraw(entries, [])).toBeNull();
  });
});

describe('ルームのモード', () => {
  it('保存されていなければクイズとして扱う', () => {
    // モードが増える前に作られたルームには mode が入っていない。
    expect(roomModeOf(undefined)).toBe('quiz');
    expect(roomModeOf(null)).toBe('quiz');
    expect(roomModeOf('')).toBe('quiz');
    expect(roomModeOf('unknown-mode')).toBe('quiz');
  });

  it('保存された値をそのまま読む', () => {
    for (const mode of ROOM_MODES) {
      expect(roomModeOf(mode)).toBe(mode);
    }
  });

  it('抽選会とビンゴは「1 つずつ引く」モード', () => {
    expect(isDrawMode('lottery')).toBe(true);
    expect(isDrawMode('bingo')).toBe(true);
    expect(isDrawMode('quiz')).toBe(false);
  });

  it('参加者のスマホを使うのはクイズだけ', () => {
    // 抽選会は名簿、ビンゴは紙のカードで進める。参加受付を開かない。
    expect(acceptsParticipants('quiz')).toBe(true);
    expect(acceptsParticipants('lottery')).toBe(false);
    expect(acceptsParticipants('bingo')).toBe(false);
  });
});
