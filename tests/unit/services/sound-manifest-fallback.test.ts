import { describe, expect, it, vi } from 'vitest';
import type * as SoundRepositoryModule from '@/infrastructure/firebase/repositories/sound-repository';

vi.mock('server-only', () => ({}));

/**
 * 保存先が落ちているときの効果音。
 *
 * 差し替えた音が鳴らないのと、音が一切鳴らないのとでは会場での痛さが違う。
 * Firestore が一時的に読めなくても、**同梱の音の一覧を返して投影を黙らせない**。
 *
 * URL だけで回すルーレット（`/roulette`）はルームを持たず、
 * 効果音の一覧だけをサーバーへ取りに行く。ここが 500 を返すと、
 * その画面は音が出ないだけでなく原因も分からない。
 */

const getSoundSettings = vi.fn<typeof SoundRepositoryModule.getSoundSettings>();
const findLegacySoundSettings = vi.fn<typeof SoundRepositoryModule.findLegacySoundSettings>();

vi.mock('@/infrastructure/firebase/repositories/sound-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof SoundRepositoryModule>();
  return {
    ...actual,
    getSoundSettings: (ownerId: string) => getSoundSettings(ownerId),
    findLegacySoundSettings: (ownerId: string) => findLegacySoundSettings(ownerId),
  };
});

describe('効果音の一覧', () => {
  it('保存先を読めなくても、同梱の音の一覧を返す', async () => {
    getSoundSettings.mockRejectedValue(new Error('14 UNAVAILABLE: No connection established'));

    const { buildSoundManifest } = await import('@/application/services/sound-service');
    const { DEFAULT_SOUND_URLS, SOUND_NAMES } = await import('@/domain/sound/sound-catalog');

    const manifest = await buildSoundManifest();

    // 抜けを許さない。1 つでも欠けると投影準備に「用意できなかった音」として並ぶ。
    expect(Object.keys(manifest)).toHaveLength(SOUND_NAMES.length);
    for (const name of SOUND_NAMES) {
      expect(manifest[name]).toBe(DEFAULT_SOUND_URLS[name]);
    }
  });

  it('読めたときは差し替えた音を返す', async () => {
    getSoundSettings.mockResolvedValue({
      ownerId: 'system',
      publicId: '11111111-1111-4111-8111-111111111111',
      sounds: {
        'draw-win': {
          assetId: 'a',
          bucket: 'b',
          objectPath: 'sounds/system/a.wav',
          mimeType: 'audio/wav',
          byteSize: 44,
          originalName: 'win.wav',
          updatedAtMs: 1_700_000_000_000,
        },
      },
    });

    const { buildSoundManifest } = await import('@/application/services/sound-service');
    const { DEFAULT_SOUND_URLS } = await import('@/domain/sound/sound-catalog');

    const manifest = await buildSoundManifest();

    expect(manifest['draw-win']).toBe(
      '/api/sounds/11111111-1111-4111-8111-111111111111/draw-win?v=1700000000000',
    );
    // 触っていない音はそのまま同梱の音。
    expect(manifest['draw-spin']).toBe(DEFAULT_SOUND_URLS['draw-spin']);
  });
});
