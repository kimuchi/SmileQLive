// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildUpMs, usePollReveal, POLL_BUILD_UP_MAX_MS } from '@/hooks/use-poll-reveal';

/**
 * 投票結果の「ためて出す」進み方。
 *
 * ここで固めたいのは 3 つ。
 *   1. 司会が押した瞬間に答えを出さない。**ためてから**出す。
 *   2. ためる長さは音の素材の実際の長さに合わせる（差し替えても間延びしない）。
 *   3. 途中から画面を開いたとき（2 件以上まとめて届いたとき）はためない。
 *      すでに会場へ出ている順位を投影が伏せてしまうため。
 */

type Props = Parameters<typeof usePollReveal>[0];

function setup(overrides: Partial<Props> = {}) {
  const onBuildUpStart = vi.fn();
  const onReveal = vi.fn();
  const initialProps: Props = {
    revealedCount: 0,
    nextRank: 3,
    buildUpSeconds: 2,
    onBuildUpStart,
    onReveal,
    ...overrides,
  };
  const view = renderHook((props: Props) => usePollReveal(props), { initialProps });
  /** 差分だけを渡して次の状態にする（呼び出し先を毎回書き直さないため）。 */
  const update = (patch: Partial<Props>) => {
    view.rerender({ ...initialProps, ...patch });
  };
  return { ...view, update, onBuildUpStart, onReveal };
}

describe('ためる長さ', () => {
  it('素材の長さに合わせる', () => {
    expect(buildUpMs(3)).toBe(3000);
  });

  it('短すぎる素材でも最低限はためる', () => {
    // 0.2 秒の素材でそのまま出すと、押した瞬間に答えが出てしまう。
    expect(buildUpMs(0.2)).toBe(1500);
  });

  it('長すぎる素材でも待たせすぎない', () => {
    expect(buildUpMs(30)).toBe(POLL_BUILD_UP_MAX_MS);
  });

  it('素材が読めていなければ既定の長さ', () => {
    expect(buildUpMs(null)).toBe(2500);
  });
});

describe('ためて出す', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('届いた直後は出さず、ためている順位だけを見せる', () => {
    const { result, update, onBuildUpStart, onReveal } = setup();

    act(() => {
      update({ revealedCount: 1, nextRank: 3 });
    });

    expect(result.current.pendingRank).toBe(3);
    // まだ中身は出さない。
    expect(result.current.shownCount).toBe(0);
    expect(onBuildUpStart).toHaveBeenCalledTimes(1);
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('ためる時間が過ぎたら出す', () => {
    const { result, update, onReveal } = setup();

    act(() => {
      update({ revealedCount: 1, nextRank: 3 });
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.pendingRank).toBeNull();
    expect(result.current.shownCount).toBe(1);
    expect(onReveal).toHaveBeenCalledWith(3);
  });

  it('順位ごとに 1 回ずつためる', () => {
    const { result, update, onBuildUpStart, onReveal } = setup();

    act(() => {
      update({ revealedCount: 1, nextRank: 3 });
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      update({ revealedCount: 2, nextRank: 2 });
    });

    expect(result.current.pendingRank).toBe(2);
    expect(result.current.shownCount).toBe(1);
    expect(onBuildUpStart).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.shownCount).toBe(2);
    expect(onReveal).toHaveBeenLastCalledWith(2);
  });

  it('取り直しでは同じ順位をため直さない', () => {
    // 投影は 1 秒ごとに状態を取り直す。そのたびにため直すと永遠に出ない。
    const { result, update, onBuildUpStart } = setup();

    act(() => {
      update({ revealedCount: 1, nextRank: 3 });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
      update({ revealedCount: 1, nextRank: 3 });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onBuildUpStart).toHaveBeenCalledTimes(1);
    expect(result.current.shownCount).toBe(1);
  });

  it('途中から画面を開いたときはためずに追いつく', () => {
    // すでに 3 位・2 位が会場へ出ている。投影がそれを伏せてはいけない。
    const { result, update, onBuildUpStart, onReveal } = setup();

    act(() => {
      update({ revealedCount: 2, nextRank: 2 });
    });

    expect(result.current.shownCount).toBe(2);
    expect(result.current.pendingRank).toBeNull();
    expect(onBuildUpStart).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('司会が数え直して減ったらその場で合わせる', () => {
    const { result, update } = setup({ revealedCount: 3 });

    act(() => {
      update({ revealedCount: 0, nextRank: 3 });
    });

    expect(result.current.shownCount).toBe(0);
    expect(result.current.pendingRank).toBeNull();
  });
});
