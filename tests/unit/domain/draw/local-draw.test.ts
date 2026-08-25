import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAW_SETTINGS } from '@/domain/draw/draw-list';
import type { StageDraw } from '@/domain/draw/draw-stage';
import { applyLocalDraw, localCandidates, pickLocalEntry } from '@/domain/draw/local-draw';

/**
 * ブラウザの中だけで引く抽選（デモ）。
 *
 * ここで固めたいのは 2 つ。
 *   1. 本番と同じ扱いにする。抽選会・ビンゴは引いたら減り、**ルーレットは減らない**。
 *   2. 用意した抽選リストをそのまま使える（デモ用の別データを作らない）。
 */

function poolOf(labels: string[], weights?: number[]): StageDraw {
  return {
    title: 'テスト',
    kind: weights ? 'weighted' : 'name',
    settings: DEFAULT_DRAW_SETTINGS,
    entries: labels.map((label, index) => ({
      id: `e${index}`,
      position: index + 1,
      label,
      image: null,
      ...(weights ? { weight: weights[index] } : {}),
    })),
    drawn: [],
    latestEntryId: null,
    latestOrder: null,
    remainingCount: labels.length,
    numberRange: null,
    background: null,
  };
}

describe('デモの抽選', () => {
  it('引いた記録を差し替えても、母集団と設定は元のまま', () => {
    const pool = poolOf(['A', 'B', 'C']);
    const draw = applyLocalDraw(pool, [{ order: 1, entryId: 'e1' }], 'lottery');

    expect(draw.entries).toEqual(pool.entries);
    expect(draw.settings).toBe(pool.settings);
    expect(draw.title).toBe(pool.title);
    expect(draw.latestEntryId).toBe('e1');
    expect(draw.latestOrder).toBe(1);
  });

  it('抽選会は引いたぶんだけ減る', () => {
    const pool = poolOf(['A', 'B', 'C']);
    const draw = applyLocalDraw(pool, [{ order: 1, entryId: 'e1' }], 'lottery');
    expect(draw.remainingCount).toBe(2);
  });

  it('ルーレットは引いても減らない', () => {
    // 減らすと重みの意味が無くなり、最後は残り 1 つが必ず出てしまう。
    const pool = poolOf(['当たり', 'はずれ'], [1, 9]);
    const draw = applyLocalDraw(pool, [{ order: 1, entryId: 'e0' }], 'roulette');
    expect(draw.remainingCount).toBe(2);
  });

  it('抽選会は同じものを二度引かない', () => {
    const pool = poolOf(['A', 'B', 'C']);
    const drawn = [
      { order: 1, entryId: 'e0' },
      { order: 2, entryId: 'e2' },
    ];
    expect(localCandidates(pool, drawn, 'lottery').map((entry) => entry.id)).toEqual(['e1']);

    // 残り 1 件なので、どの乱数でもそれが出る。
    expect(pickLocalEntry(pool, drawn, 'lottery', () => 0)?.id).toBe('e1');
    expect(pickLocalEntry(pool, drawn, 'lottery', () => 0.999)?.id).toBe('e1');
  });

  it('引き切ったら null（呼び出し側が「最初から」へ導く）', () => {
    const pool = poolOf(['A']);
    expect(pickLocalEntry(pool, [{ order: 1, entryId: 'e0' }], 'lottery', () => 0)).toBeNull();
  });

  it('ルーレットは重みに応じて選ぶ', () => {
    // 重み 1 : 9。くじの番号 0 は前の扇、9 は後ろの扇に入る。
    const pool = poolOf(['当たり', 'はずれ'], [1, 9]);
    expect(pickLocalEntry(pool, [], 'roulette', () => 0)?.label).toBe('当たり');
    expect(pickLocalEntry(pool, [], 'roulette', () => 0.5)?.label).toBe('はずれ');
    expect(pickLocalEntry(pool, [], 'roulette', () => 0.999)?.label).toBe('はずれ');
  });

  it('ルーレットは同じものを何度でも引ける', () => {
    const pool = poolOf(['当たり', 'はずれ'], [1, 9]);
    const drawn = [{ order: 1, entryId: 'e0' }];
    expect(pickLocalEntry(pool, drawn, 'roulette', () => 0)?.id).toBe('e0');
  });
});
