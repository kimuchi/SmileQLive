// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDrawSoundCues } from '@/components/presentation/use-projector-audio';

/**
 * 抽選会・ビンゴ・ルーレットで「いつ鳴らすか」。
 *
 * ここで固めたいのは 3 つ。
 *   1. 回している間だけ回転音を鳴らす。
 *   2. **回し終わった瞬間**に当選音を鳴らす（回し始めではない）。
 *   3. 引き直したら**また鳴る**。
 *      通し番号だけを「もう鳴らした」の鍵にすると、
 *      「最初からやり直す」やデモの 2 周目が無音になる（実際にそうなった）。
 */

type Args = Parameters<typeof useDrawSoundCues>[0];

function setup(initial: Partial<Args> = {}) {
  const play = vi.fn();
  const startLoop = vi.fn();
  const stopLoop = vi.fn();
  const base: Args = {
    play,
    startLoop,
    stopLoop,
    isUnlocked: true,
    spinning: false,
    latestOrder: null,
    ...initial,
  };
  const view = renderHook((props: Args) => useDrawSoundCues(props), { initialProps: base });
  return { play, startLoop, stopLoop, view, base };
}

function played(play: ReturnType<typeof vi.fn>): string[] {
  return play.mock.calls.map((call) => String(call[0]));
}

describe('抽選の効果音', () => {
  it('回している間だけ回転音を鳴らす', () => {
    const { startLoop, stopLoop, view, base } = setup();
    expect(startLoop).not.toHaveBeenCalled();

    view.rerender({ ...base, spinning: true });
    expect(startLoop).toHaveBeenCalledWith('draw-spin');

    view.rerender({ ...base, spinning: false, latestOrder: 1 });
    expect(stopLoop).toHaveBeenCalledWith('draw-spin');
  });

  it('回し終わった瞬間に当選音を鳴らす（回し始めでは鳴らさない）', () => {
    const { play, view, base } = setup();

    // 引いた記録と回転が同時に来る。ここではまだ結果を出していない。
    view.rerender({ ...base, spinning: true, latestOrder: 1 });
    expect(played(play)).toEqual([]);

    view.rerender({ ...base, spinning: false, latestOrder: 1 });
    expect(played(play)).toEqual(['draw-win']);
  });

  it('同じ結果を見直しても鳴り直さない（取り直し・再接続）', () => {
    const { play, view, base } = setup();
    view.rerender({ ...base, spinning: true, latestOrder: 1 });
    view.rerender({ ...base, spinning: false, latestOrder: 1 });
    expect(played(play)).toHaveLength(1);

    // Snapshot を取り直しただけ。回っていないので鳴らない。
    view.rerender({ ...base, spinning: false, latestOrder: 1 });
    expect(played(play)).toHaveLength(1);
  });

  it('引き直したら、同じ通し番号でもまた鳴る', () => {
    const { play, view, base } = setup();
    view.rerender({ ...base, spinning: true, latestOrder: 1 });
    view.rerender({ ...base, spinning: false, latestOrder: 1 });
    expect(played(play)).toHaveLength(1);

    // 「最初からやり直す」。記録が消える。
    view.rerender({ ...base, spinning: false, latestOrder: null });
    // もう一度 1 件目を引く。
    view.rerender({ ...base, spinning: true, latestOrder: 1 });
    view.rerender({ ...base, spinning: false, latestOrder: 1 });

    expect(played(play)).toHaveLength(2);
  });

  it('二重再生防止の鍵は呼び出し側が決める（デモは鍵なし）', () => {
    const { play, view, base } = setup();
    view.rerender({ ...base, spinning: true, latestOrder: 1, dedupeKey: 'draw:12' });
    view.rerender({ ...base, spinning: false, latestOrder: 1, dedupeKey: 'draw:12' });

    expect(play).toHaveBeenCalledWith('draw-win', 'draw:12');

    const demo = setup();
    demo.view.rerender({ ...demo.base, spinning: true, latestOrder: 1 });
    demo.view.rerender({ ...demo.base, spinning: false, latestOrder: 1 });
    // 鍵を渡さない＝毎回鳴らす。デモは同じ番号を何度も引き直す。
    expect(demo.play).toHaveBeenCalledWith('draw-win', undefined);
  });

  it('音が出せないうちは鳴らさない', () => {
    const { play, startLoop, view, base } = setup({ isUnlocked: false });
    view.rerender({ ...base, isUnlocked: false, spinning: true, latestOrder: 1 });
    view.rerender({ ...base, isUnlocked: false, spinning: false, latestOrder: 1 });

    expect(startLoop).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });
});
