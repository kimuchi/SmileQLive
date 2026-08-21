// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * 抽選リストが使っている画像を、使用中と数えられること。
 *
 * 画像の削除は「どこからも参照されていないとき」だけ通す作りになっている。
 * クイズしか数えていないと、景品の写真や投影の背景を消せてしまい、
 * 当日その絵だけが消えた画面になる。ここで数え漏れを止める。
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

const OWNER_UID = 'draw-media-owner';

describe.skipIf(!available)('抽選リストの画像の使用件数', () => {
  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'http://localhost';
  });

  /** 画像のメタデータだけを置く（実体は要らない）。 */
  async function seedAsset(assetId: string) {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    await getDb()
      .collection('mediaAssets')
      .doc(assetId)
      .set({
        id: assetId,
        ownerId: OWNER_UID,
        bucket: 'smileq-live-emulator.appspot.com',
        objectPath: `${OWNER_UID}/scope/${assetId}.webp`,
        mimeType: 'image/webp',
        byteSize: 1024,
        width: 800,
        height: 600,
        createdAt: Timestamp.now(),
      });
  }

  async function seedList(options: {
    kind: 'name' | 'number' | 'item';
    backgroundAssetId?: string | null;
    entryAssetIds?: (string | null)[];
  }) {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const db = getDb();
    const now = Timestamp.now();
    const listId = crypto.randomUUID();

    await db
      .collection('drawLists')
      .doc(listId)
      .set({
        id: listId,
        ownerId: OWNER_UID,
        title: '画像つきリスト',
        kind: options.kind,
        numberMin: options.kind === 'number' ? 1 : null,
        numberMax: options.kind === 'number' ? 10 : null,
        settings: {
          spinIntervalMs: 50,
          spinDurationMs: 2500,
          resultFontSize: 240,
          historyFontSize: 96,
          layout: 'board',
          backgroundAssetId: options.backgroundAssetId ?? null,
          openingVideoUrl: null,
        },
        entryCount: options.entryAssetIds?.length ?? 0,
        createdAt: now,
        updatedAt: now,
      });

    for (const [index, assetId] of (options.entryAssetIds ?? []).entries()) {
      const entryId = crypto.randomUUID();
      await db
        .collection('drawLists')
        .doc(listId)
        .collection('entries')
        .doc(entryId)
        .set({
          id: entryId,
          listId,
          position: index + 1,
          label: `景品${index + 1}`,
          imageAssetId: assetId,
          imageAlt: assetId === null ? null : '景品の写真',
          createdAt: now,
          updatedAt: now,
        });
    }

    return listId;
  }

  it('行の画像は使用中と数える', { timeout: 60_000 }, async () => {
    const assetId = crypto.randomUUID();
    await seedAsset(assetId);
    await seedList({ kind: 'item', entryAssetIds: [assetId, null] });

    const { countUsages } = await import('@/infrastructure/firebase/repositories/media-repository');

    expect(await countUsages(assetId)).toBe(1);
  });

  it('演出の背景も使用中と数える', { timeout: 60_000 }, async () => {
    const assetId = crypto.randomUUID();
    await seedAsset(assetId);
    // 数字のリストは行を持たないが、背景は持てる。
    await seedList({ kind: 'number', backgroundAssetId: assetId });

    const { countUsages } = await import('@/infrastructure/firebase/repositories/media-repository');

    expect(await countUsages(assetId)).toBe(1);
  });

  it('どこからも参照されていない画像は 0 件', { timeout: 60_000 }, async () => {
    const assetId = crypto.randomUUID();
    await seedAsset(assetId);
    await seedList({ kind: 'item', entryAssetIds: [null] });

    const { countUsages } = await import('@/infrastructure/firebase/repositories/media-repository');

    expect(await countUsages(assetId)).toBe(0);
  });
});
