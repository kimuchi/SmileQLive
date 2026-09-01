// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MediaStorageModule from '@/infrastructure/firebase/storage/media-storage';

vi.mock('server-only', () => ({}));

/**
 * 効果音の差し替え。
 *
 * ここで固めたいのは次の 5 つ。
 *   1. **デプロイし直さずに差し替えられる。** 保存すればすぐ、投影が読む一覧に載る。
 *   2. 差し替えていない音は同梱の既定音が鳴る。設定が空でも全部の音が並ぶ。
 *   3. 音の形式は**実データ**で見る。拡張子や Content-Type を信用しない。
 *   4. 差し替え直したとき、前の実体を残さない（保存先にゴミが溜まらない）。
 *   5. **設定はシステム全体で 1 つ。ログインも要らない。**
 *      司会者ごとに持っていた頃の設定は引き継ぐ（会場でいきなり既定音に戻らない）。
 */
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';

async function emulatorReachable(): Promise<boolean> {
  try {
    const response = await fetch(`http://${EMULATOR}/`, { signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

const available = await emulatorReachable();

/**
 * 設定を置くドキュメント。
 *
 * **ログインは要らない。** サービス側が固定の ID を使うので、
 * ここでは司会者を作らずに差し替えられることまで含めて確かめている。
 */
const SYSTEM = 'system';

/**
 * Cloud Storage の代わり。
 *
 * 保存先そのものは別の検査（media:doctor）が見る。
 * ここで確かめたいのは「何をどこへ置き、何を消したか」なので、
 * 置き場所は覚えるだけの偽物で足りる。
 */
const stored = new Map<string, { bytes: Uint8Array; contentType: string }>();
const deleted: string[] = [];

vi.mock('@/infrastructure/firebase/storage/media-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof MediaStorageModule>();
  return {
    ...actual,
    mediaBucketName: () => 'test-bucket',
    uploadSoundObject: async (input: {
      objectPath: string;
      buffer: Uint8Array;
      contentType: string;
    }) => {
      stored.set(input.objectPath, { bytes: input.buffer, contentType: input.contentType });
    },
    readSoundObject: async (_bucket: string, objectPath: string) => {
      const entry = stored.get(objectPath);
      if (!entry) {
        return null;
      }
      const copy = new ArrayBuffer(entry.bytes.byteLength);
      new Uint8Array(copy).set(entry.bytes);
      return copy;
    },
    deleteObject: async (ref: string) => {
      deleted.push(ref);
      const path = ref.replace(/^storage:\/\/[^/]+\//, '');
      stored.delete(path);
    },
  };
});

/** 最小の WAV。magic bytes で音声と判定させるために本物の並びを使う。 */
function wavFile(name = 'beep.wav'): File {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, 0, true);
  return new File([header], name, { type: 'audio/wav' });
}

describe.skipIf(!available)('効果音の差し替え', () => {
  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'http://localhost';
  });

  beforeEach(async () => {
    stored.clear();
    deleted.length = 0;
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const existing = await getDb().collection('soundSettings').get();
    await Promise.all(existing.docs.map((doc) => doc.ref.delete()));
  });

  it('一度も差し替えていなければ、全部の音が同梱の音として並ぶ', async () => {
    const { listSoundSettings } = await import('@/application/services/sound-service');
    const { SOUND_NAMES } = await import('@/domain/sound/sound-catalog');

    const { sounds } = await listSoundSettings();

    expect(sounds).toHaveLength(SOUND_NAMES.length);
    expect(sounds.every((slot) => slot.source === 'default')).toBe(true);
    // 既定でも URL は必ず入る。管理画面はこれをそのまま試聴に使う。
    expect(sounds.every((slot) => slot.url.startsWith('/sounds/default/'))).toBe(true);
  });

  it('差し替えると、投影が読む一覧が同梱の音から配信経路へ入れ替わる', async () => {
    const { buildSoundManifest, uploadSound } =
      await import('@/application/services/sound-service');

    const before = await buildSoundManifest();
    expect(before['draw-win']).toBe('/sounds/default/draw-win.wav');

    await uploadSound({ name: 'draw-win', file: wavFile('fanfare.wav') });

    const after = await buildSoundManifest();
    // デプロイし直していないのに、次に投影を開けば新しい音を読む。
    expect(after['draw-win']).toMatch(/^\/api\/sounds\/[0-9a-f-]{36}\/draw-win\?v=\d+$/);
    // 触っていない音はそのまま。1 音の差し替えが他へ波及しない。
    expect(after.tick).toBe('/sounds/default/tick.wav');
  });

  it('差し替えた音を配信経路から読み出せる', async () => {
    const { readSoundFile, uploadSound } = await import('@/application/services/sound-service');

    const { sounds } = await uploadSound({ name: 'fanfare', file: wavFile() });
    const slot = sounds.find((entry) => entry.name === 'fanfare');
    expect(slot?.source).toBe('custom');

    const publicId = slot?.url.split('/')[3] ?? '';
    const file = await readSoundFile(publicId, 'fanfare');

    expect(file).not.toBeNull();
    expect(file?.mimeType).toBe('audio/wav');
    expect(file?.bytes.byteLength).toBeGreaterThan(0);
  });

  it('音声でないファイルは、拡張子が .wav でも受け付けない', async () => {
    const { uploadSound } = await import('@/application/services/sound-service');
    const notAudio = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'trap.wav', {
      type: 'audio/wav',
    });

    await expect(uploadSound({ name: 'tick', file: notAudio })).rejects.toMatchObject({
      code: 'SOUND_UNSUPPORTED_TYPE',
    });
  });

  it('差し替え直すと、前に入っていた実体を残さない', async () => {
    const { uploadSound } = await import('@/application/services/sound-service');

    await uploadSound({ name: 'finish', file: wavFile('first.wav') });
    expect(stored.size).toBe(1);
    const firstPath = [...stored.keys()][0];

    await uploadSound({ name: 'finish', file: wavFile('second.wav') });

    // 新しいものだけが残る。放っておくと保存先が使わない音で膨らむ。
    expect(stored.size).toBe(1);
    expect([...stored.keys()][0]).not.toBe(firstPath);
    expect(deleted.some((ref) => ref.endsWith(firstPath as string))).toBe(true);
  });

  it('既定へ戻すと、一覧も実体も同梱の音に戻る', async () => {
    const { buildSoundManifest, resetSound, uploadSound } =
      await import('@/application/services/sound-service');

    await uploadSound({ name: 'ranking', file: wavFile() });
    const { sounds } = await resetSound('ranking');

    expect(sounds.find((slot) => slot.name === 'ranking')?.source).toBe('default');
    expect((await buildSoundManifest()).ranking).toBe('/sounds/default/ranking.wav');
    expect(stored.size).toBe(0);
  });

  /**
   * 効果音は以前**司会者ごと**に持っていた。
   *
   * システム全体の 1 件へまとめた日に、既に入れてあった音が既定へ戻ると、
   * 会場でいきなり音が変わる（当日まで気づけない類の事故）。
   * まとめ先が空のときだけ、古い設定を引き継ぐ。
   */
  it('司会者ごとに入れてあった音を引き継ぐ', async () => {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const { buildSoundManifest, listSoundSettings } =
      await import('@/application/services/sound-service');

    // まとめる前の形。司会者の uid をドキュメント ID にして置かれていた。
    await getDb()
      .collection('soundSettings')
      .doc('old-host-uid')
      .set({
        ownerId: 'old-host-uid',
        publicId: '11111111-1111-4111-8111-111111111111',
        sounds: {
          fanfare: {
            assetId: 'asset-1',
            bucket: 'smileq-live-emulator.appspot.com',
            objectPath: 'sounds/old-host-uid/asset-1.wav',
            mimeType: 'audio/wav',
            byteSize: 44,
            originalName: 'fanfare.wav',
            updatedAtMs: 1_700_000_000_000,
          },
        },
        updatedAt: Timestamp.now(),
      });

    const { sounds } = await listSoundSettings();
    expect(sounds.find((slot) => slot.name === 'fanfare')?.source).toBe('custom');

    // 配信 ID も引き継ぐ。既に開いている投影画面の音の URL がそのまま生きる。
    expect((await buildSoundManifest()).fanfare).toBe(
      '/api/sounds/11111111-1111-4111-8111-111111111111/fanfare?v=1700000000000',
    );

    // 引き継ぎ元は消す。同じ配信 ID の設定が 2 つあると、
    // あとで差し替えたのに古い方の音が返ることがある。
    const docs = await getDb().collection('soundSettings').get();
    expect(docs.docs.map((doc) => doc.id)).toEqual([SYSTEM]);
  });

  it('引き継ぎは 1 度だけで、そのあとは差し替えを上書きしない', async () => {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const { listSoundSettings, uploadSound } =
      await import('@/application/services/sound-service');

    await getDb()
      .collection('soundSettings')
      .doc('old-host-uid')
      .set({
        ownerId: 'old-host-uid',
        publicId: '22222222-2222-4222-8222-222222222222',
        sounds: {
          tick: {
            assetId: 'asset-2',
            bucket: 'b',
            objectPath: 'sounds/old-host-uid/asset-2.wav',
            mimeType: 'audio/wav',
            byteSize: 44,
            originalName: 'tick.wav',
            updatedAtMs: 1,
          },
        },
        updatedAt: Timestamp.now(),
      });

    await listSoundSettings();
    await uploadSound({ name: 'finish', file: wavFile('new.wav') });

    const { sounds } = await listSoundSettings();
    // 引き継いだ音も、そのあと入れた音も、両方そのまま残る。
    expect(sounds.find((slot) => slot.name === 'tick')?.source).toBe('custom');
    expect(sounds.find((slot) => slot.name === 'finish')?.source).toBe('custom');
  });

  it('差し替えた音の URL は、差し替えるたびに変わる', async () => {
    const { buildSoundManifest, uploadSound } =
      await import('@/application/services/sound-service');

    await uploadSound({ name: 'question-start', file: wavFile('a.wav') });
    const first = (await buildSoundManifest())['question-start'];

    await new Promise((resolve) => setTimeout(resolve, 5));
    await uploadSound({ name: 'question-start', file: wavFile('b.wav') });
    const second = (await buildSoundManifest())['question-start'];

    // 同じ URL のままだと、会の途中で差し替えても古い音がキャッシュから鳴る。
    expect(second).not.toBe(first);
  });
});
