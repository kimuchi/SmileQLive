import { describe, expect, it } from 'vitest';
import { spinTotalMs } from '@/hooks/use-draw-roulette';

/**
 * 回し始めてから止まりきるまでの時間。
 *
 * デモの自動送りはこの値を基準に「止まってから 2 秒」を数える。
 * 回す時間 (spinDurationMs) だけを見て次を回すと、**減速の途中で次が始まり**、
 * 結果を見せる間が無くなる（実際にそうなった）。
 */
describe('回して止まりきるまでの時間', () => {
  it('回す時間より必ず長い（減速の分が乗る）', () => {
    expect(spinTotalMs(50, 1800)).toBeGreaterThan(1800);
  });

  it('減速の分は数秒ある。回す時間だけで数えると足りない', () => {
    // 50ms から 700ms まで 1.1 倍ずつ伸ばすので、減速だけで 6 秒を超える。
    expect(spinTotalMs(50, 0)).toBeGreaterThan(6000);
  });

  it('切り替えが速いほど減速が長くなる', () => {
    expect(spinTotalMs(50, 1000)).toBeGreaterThan(spinTotalMs(400, 1000));
  });

  it('すでに遅い間隔なら、減速はほとんど乗らない', () => {
    expect(spinTotalMs(700, 1000)).toBe(1000);
  });
});
