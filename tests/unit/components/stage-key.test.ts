import { describe, expect, it } from 'vitest';
import { stageBodyKey } from '@/components/presentation/stage-key';

/**
 * 投影の本体を作り直すかどうか。
 *
 * 抽選の画面を場面ごとに作り直すと、回す演出を持っている部品が
 * 「画面を開いた直後」の状態へ戻る。その結果、**最初の 1 件が回らずに
 * いきなり結果から出る**（実際にそうなった）。ここでそれを止める。
 */
describe('投影の本体を作り直す鍵', () => {
  it('抽選では場面が変わっても同じ鍵（作り直さない）', () => {
    const ready = stageBodyKey({ drawMode: true, phase: 'draw_ready', questionId: null });
    const revealed = stageBodyKey({ drawMode: true, phase: 'draw_revealed', questionId: null });
    const spinning = stageBodyKey({ drawMode: true, phase: 'draw_spinning', questionId: null });

    expect(revealed).toBe(ready);
    expect(spinning).toBe(ready);
  });

  it('クイズでは場面ごとに違う鍵（入場効果をやり直す）', () => {
    const open = stageBodyKey({ drawMode: false, phase: 'question_open', questionId: 'q1' });
    const locked = stageBodyKey({ drawMode: false, phase: 'question_locked', questionId: 'q1' });

    expect(locked).not.toBe(open);
  });

  it('クイズでは問題が変わっても違う鍵', () => {
    const first = stageBodyKey({ drawMode: false, phase: 'question_open', questionId: 'q1' });
    const second = stageBodyKey({ drawMode: false, phase: 'question_open', questionId: 'q2' });

    expect(second).not.toBe(first);
  });
});
