// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDrawRoulette } from '@/hooks/use-draw-roulette';
import type { StageDrawEntry } from '@/domain/draw/draw-stage';

/**
 * 抽選のルーレット演出。
 *
 * 会場で困るのは次の 2 つなので、ここで固定する。
 * - 画面を開いた直後にルーレットが回り出す（「今引いた」ように見える）
 * - 取り消し・リセットのあとにも回り出す
 *
 * 当たりそのものはサーバーが決めている。ここは**見せ方**だけの検証。
 */

function entry(id: string, label: string): StageDrawEntry {
  return { id, position: 1, label, image: null };
}

const CANDIDATES = [entry('a', '山田'), entry('b', '田中'), entry('c', '佐藤')];

type Props = Parameters<typeof useDrawRoulette>[0];

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    latestOrder: null,
    winner: null,
    candidates: CANDIDATES,
    intervalMs: 50,
    durationMs: 500,
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('抽選のルーレット', () => {
  it('画面を開いた直後の結果では回さない', () => {
    // 進行中のルームへ後から繋いだとき、いきなり回ると「今引いた」ように見える。
    const { result } = renderHook((props: Props) => useDrawRoulette(props), {
      initialProps: baseProps({ latestOrder: 3, winner: entry('c', '佐藤') }),
    });

    expect(result.current.spinning).toBe(false);
    expect(result.current.display?.label).toBe('佐藤');
  });

  it('引いたら回り始め、時間が経つと当たりで止まる', () => {
    const { result, rerender } = renderHook((props: Props) => useDrawRoulette(props), {
      initialProps: baseProps({ latestOrder: null, winner: null }),
    });

    // 1 件目を引いた。
    rerender(baseProps({ latestOrder: 1, winner: entry('b', '田中'), candidates: CANDIDATES }));

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.spinning).toBe(true);

    // 回す時間 + 減速ぶんを進める。
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current.spinning).toBe(false);
    expect(result.current.display?.label).toBe('田中');
  });

  it('回している間は候補が切り替わる', () => {
    const { result, rerender } = renderHook((props: Props) => useDrawRoulette(props), {
      initialProps: baseProps({ latestOrder: null, winner: null }),
    });
    rerender(baseProps({ latestOrder: 1, winner: entry('b', '田中') }));

    const seen = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      act(() => {
        vi.advanceTimersByTime(50);
      });
      const label = result.current.display?.label;
      if (label) {
        seen.add(label);
      }
    }

    // 同じものが出続けると「止まっている」ように見える。2 種類以上は出ること。
    expect(seen.size).toBeGreaterThan(1);
  });

  it('同じ結果のまま取り直しても回り直さない', () => {
    // Snapshot は再接続や進捗更新で何度も取り直される。
    const { result, rerender } = renderHook((props: Props) => useDrawRoulette(props), {
      initialProps: baseProps({ latestOrder: null, winner: null }),
    });
    rerender(baseProps({ latestOrder: 1, winner: entry('b', '田中') }));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.spinning).toBe(false);

    rerender(baseProps({ latestOrder: 1, winner: entry('b', '田中') }));
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.spinning).toBe(false);
    expect(result.current.display?.label).toBe('田中');
  });

  it('取り消して番号が戻っても回さない', () => {
    const { result, rerender } = renderHook((props: Props) => useDrawRoulette(props), {
      initialProps: baseProps({ latestOrder: null, winner: null }),
    });
    rerender(baseProps({ latestOrder: 2, winner: entry('b', '田中') }));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // 直前の 1 件を取り消した。
    rerender(baseProps({ latestOrder: 1, winner: entry('a', '山田') }));
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.spinning).toBe(false);
    expect(result.current.display?.label).toBe('山田');
  });

  it('リセットして 1 件も無くなったら何も出さない', () => {
    const { result, rerender } = renderHook((props: Props) => useDrawRoulette(props), {
      initialProps: baseProps({ latestOrder: 1, winner: entry('a', '山田') }),
    });

    rerender(baseProps({ latestOrder: null, winner: null }));
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.spinning).toBe(false);
    expect(result.current.display).toBeNull();
  });

  it('投影開始の操作が済むまでは回さない', () => {
    // 音が出せない状態で回しても間が抜ける。結果だけを出す。
    const { result, rerender } = renderHook((props: Props) => useDrawRoulette(props), {
      initialProps: baseProps({ latestOrder: null, winner: null, enabled: false }),
    });

    rerender(baseProps({ latestOrder: 1, winner: entry('b', '田中'), enabled: false }));
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.spinning).toBe(false);
    expect(result.current.display?.label).toBe('田中');
  });

  it('候補が 1 つしか無ければ回さずに出す', () => {
    const only = [entry('a', 'ひとり')];
    const { result, rerender } = renderHook((props: Props) => useDrawRoulette(props), {
      initialProps: baseProps({ latestOrder: null, winner: null, candidates: only }),
    });

    rerender(baseProps({ latestOrder: 1, winner: entry('a', 'ひとり'), candidates: only }));
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.spinning).toBe(false);
    expect(result.current.display?.label).toBe('ひとり');
  });

  it('回している途中で画面を離れてもタイマーを残さない', () => {
    const { rerender, unmount } = renderHook((props: Props) => useDrawRoulette(props), {
      initialProps: baseProps({ latestOrder: null, winner: null }),
    });
    rerender(baseProps({ latestOrder: 1, winner: entry('b', '田中') }));
    act(() => {
      vi.advanceTimersByTime(100);
    });

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
