// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AudioManagerModule from '@/lib/audio/projector-audio-manager';

/**
 * 投影画面が読む「音の一覧」の置き場所。
 *
 * 管理画面から差し替えた音を鳴らすには、投影が**ルームごとの一覧**を
 * 読みに行く必要がある。同梱ファイルの一覧 (/sounds/manifest.json) を
 * 見に行く作りへ戻ると、差し替えても会場では古い音のままになる。
 * ここでその置き場所を固定する。
 */

const captured: Array<Record<string, unknown>> = [];

vi.mock('@/lib/audio/projector-audio-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof AudioManagerModule>();
  return {
    ...actual,
    createProjectorAudioManager: (options: Record<string, unknown>) => {
      captured.push(options);
      return {
        isUnlocked: false,
        unlock: vi.fn(async () => {}),
        preload: vi.fn(async () => ({ manifestOk: true, ready: [], failed: [] })),
        play: vi.fn(),
        startLoop: vi.fn(),
        stopLoop: vi.fn(),
        playTest: vi.fn(async () => ({ ok: true, reason: null })),
        durationOf: () => null,
        setMuted: vi.fn(),
        setVolume: vi.fn(),
        dispose: vi.fn(),
      };
    },
  };
});

const { useProjectorAudio } = await import('@/components/presentation/use-projector-audio');

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('投影画面が読む音の一覧', () => {
  it('ルームごとの一覧を読む', () => {
    renderHook(() => useProjectorAudio('room-abc'));

    expect(captured[0]?.manifestUrl).toBe('/api/rooms/room-abc/sounds');
  });

  it('ルームが変われば読み直す', () => {
    const { rerender } = renderHook(({ roomId }) => useProjectorAudio(roomId), {
      initialProps: { roomId: 'room-1' },
    });
    rerender({ roomId: 'room-2' });

    // 差し替えは司会者ごとなので、ルームが違えば鳴る音も違いうる。
    expect(captured.map((options) => options.manifestUrl)).toEqual([
      '/api/rooms/room-1/sounds',
      '/api/rooms/room-2/sounds',
    ]);
  });
});
