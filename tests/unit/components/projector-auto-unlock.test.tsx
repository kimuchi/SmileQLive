// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AudioManagerModule from '@/lib/audio/projector-audio-manager';

/**
 * 効果音の自動解除。
 *
 * 以前は「投影を開始」を押すまで画面がオーバーレイで止まり、押し忘れると
 * **動いているように見えて何も起きない**画面になっていた。会場でいちばん困る形なので、
 *
 *   1. 読み込み直後に静かに解除を試す（自動再生が許可された端末ではこれで鳴る）
 *   2. 駄目なら、画面のどこかを触った最初の一回で解除する
 *
 * という作りにしてある。ここではその 2 つを固定する。
 * 「効果音を有効にする」を押さないと解除されない作りに戻ったら、このテストが落ちる。
 */

const unlock = vi.fn();
const preload = vi.fn();
let unlocked = false;

vi.mock('@/lib/audio/projector-audio-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof AudioManagerModule>();
  return {
    ...actual,
    createProjectorAudioManager: () => ({
      get isUnlocked() {
        return unlocked;
      },
      unlock,
      preload,
      play: vi.fn(),
      startLoop: vi.fn(),
      stopLoop: vi.fn(),
      playTest: vi.fn(async () => ({ ok: true, reason: null })),
      durationOf: () => null,
      setMuted: vi.fn(),
      setVolume: vi.fn(),
      dispose: vi.fn(),
    }),
  };
});

const { useProjectorAudio } = await import('@/components/presentation/use-projector-audio');

beforeEach(() => {
  unlocked = false;
  unlock.mockReset();
  unlock.mockImplementation(async () => {});
  preload.mockReset();
  preload.mockResolvedValue({ manifestOk: true, ready: ['tick'], failed: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('効果音の自動解除', () => {
  it('読み込み直後に、黙って解除を試す', async () => {
    await act(async () => {
      renderHook(() => useProjectorAudio('room-1'));
    });

    // silent: 解除できなくても注意文を出さない（自動で試しているだけなので）。
    expect(unlock).toHaveBeenCalledWith({ silent: true });
  });

  it('自動で解除できたら、その時点から鳴らせる', async () => {
    unlocked = true;

    const { result } = renderHook(() => useProjectorAudio('room-2'));
    await act(async () => {});

    expect(result.current.isUnlocked).toBe(true);
    // 鳴らせるようになったので、音源の先読みまで進む。
    expect(preload).toHaveBeenCalled();
  });

  it('駄目なら、画面のどこかを触った最初の一回で解除する', async () => {
    const { result } = renderHook(() => useProjectorAudio('room-3'));
    await act(async () => {});
    unlock.mockClear();

    // ボタンではなく、画面のどこか。会場の操作者が何をしても解除される。
    unlocked = true;
    await act(async () => {
      window.dispatchEvent(new Event('pointerdown'));
    });

    expect(unlock).toHaveBeenCalledWith({ silent: true });
    expect(result.current.isUnlocked).toBe(true);
  });

  it('キー操作でも解除する', async () => {
    renderHook(() => useProjectorAudio('room-4'));
    await act(async () => {});
    unlock.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event('keydown'));
    });

    expect(unlock).toHaveBeenCalled();
  });

  it('解除できたあとは、触るたびに呼び直さない', async () => {
    unlocked = true;
    renderHook(() => useProjectorAudio('room-5'));
    await act(async () => {});
    unlock.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event('pointerdown'));
    });

    expect(unlock).not.toHaveBeenCalled();
  });
});
