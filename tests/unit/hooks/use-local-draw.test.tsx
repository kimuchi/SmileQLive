// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAW_SETTINGS } from '@/domain/draw/draw-list';
import type { StageDraw } from '@/domain/draw/draw-stage';
import { useLocalDraw } from '@/hooks/use-local-draw';

/**
 * 既存のルームをデモにする。
 *
 * ここで固めたいのは 3 つ。
 *   1. 用意した抽選リストをそのまま使える（デモ用の別データを作らない）。
 *   2. デモを抜けたら**引いた記録を残さない**。
 *      残ると、戻ったときに前回の続きから始まってしまう。
 *   3. ルーレットは「スタート → ストップ」の 2 段で進む。
 */

const pool: StageDraw = {
  title: '社員表彰 抽選会',
  kind: 'name',
  settings: DEFAULT_DRAW_SETTINGS,
  entries: ['青木', '飯田', '上野'].map((label, index) => ({
    id: `e${index}`,
    position: index + 1,
    label,
    image: null,
  })),
  drawn: [],
  latestEntryId: null,
  latestOrder: null,
  remainingCount: 3,
  numberRange: null,
  background: null,
};

type Props = Parameters<typeof useLocalDraw>[0];

function setup(overrides: Partial<Props> = {}) {
  const initialProps: Props = {
    pool,
    mode: 'lottery',
    active: true,
    poolKey: 'room-1',
    ...overrides,
  };
  return renderHook((props: Props) => useLocalDraw(props), { initialProps });
}

describe('デモの進行', () => {
  it('デモ中でなければ何も持たない', () => {
    const { result } = setup({ active: false });
    expect(result.current.draw).toBeNull();
  });

  it('用意した抽選リストの中身をそのまま使う', () => {
    const { result } = setup();
    expect(result.current.draw?.title).toBe('社員表彰 抽選会');
    expect(result.current.draw?.entries.map((entry) => entry.label)).toEqual([
      '青木',
      '飯田',
      '上野',
    ]);
  });

  it('引くと記録が増え、残りが減る', () => {
    const { result } = setup();
    act(() => {
      result.current.drawNext();
    });

    expect(result.current.draw?.drawn).toHaveLength(1);
    expect(result.current.draw?.remainingCount).toBe(2);
    expect(result.current.phase).toBe('revealed');
  });

  it('引き切ると exhausted になる', () => {
    const { result } = setup();
    for (let index = 0; index < 3; index += 1) {
      act(() => {
        result.current.drawNext();
      });
    }
    expect(result.current.exhausted).toBe(true);

    // それ以上は増えない（同じものを二度引かない）。
    act(() => {
      result.current.drawNext();
    });
    expect(result.current.draw?.drawn).toHaveLength(3);
  });

  it('「最初から」で記録を捨てる', () => {
    const { result } = setup();
    act(() => {
      result.current.drawNext();
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.draw?.drawn).toHaveLength(0);
    expect(result.current.phase).toBe('ready');
  });

  it('デモを抜けたら記録も自動も残らない', () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.drawNext();
      result.current.setAuto(true);
    });
    expect(result.current.auto).toBe(true);

    rerender({ pool, mode: 'lottery', active: false, poolKey: 'room-1' });
    expect(result.current.draw).toBeNull();

    // 戻っても前回の続きにならない。
    rerender({ pool, mode: 'lottery', active: true, poolKey: 'room-1' });
    expect(result.current.draw?.drawn).toHaveLength(0);
    expect(result.current.auto).toBe(false);
  });

  it('別のルームの記録を引き継がない', () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.drawNext();
    });
    expect(result.current.draw?.drawn).toHaveLength(1);

    rerender({ pool, mode: 'lottery', active: true, poolKey: 'room-2' });
    expect(result.current.draw?.drawn).toHaveLength(0);
  });

  it('ルーレットはスタートで回り、ストップで決まる', () => {
    const { result } = setup({ mode: 'roulette' });

    act(() => {
      result.current.startSpin();
    });
    // スタートの時点ではまだ何も決まっていない。
    expect(result.current.phase).toBe('spinning');
    expect(result.current.draw?.drawn).toHaveLength(0);

    act(() => {
      result.current.drawNext();
    });
    expect(result.current.phase).toBe('revealed');
    expect(result.current.draw?.drawn).toHaveLength(1);
    // 引いても母集団は減らない。
    expect(result.current.draw?.remainingCount).toBe(3);
    expect(result.current.exhausted).toBe(false);
  });
});
