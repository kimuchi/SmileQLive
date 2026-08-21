// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '@/lib/auth/session';

vi.mock('server-only', () => ({}));

/**
 * 抽選会・ビンゴのルーム作成。
 *
 * ここで固めたいのは次の 3 つ。
 *   1. **参加受付を開かない**。参加者が来ないモードなので、
 *      二次元コードを拾われても入れない状態で作る。
 *   2. 抽選リストの中身を**ルームへ写し取る**（当日リストを編集されても進行が変わらない）。
 *   3. モードに合わない種類のリストを弾く
 *      （抽選会で数字を引いても意味が無く、ビンゴで名簿を引いても成立しない）。
 *
 * 認証はテストのために差し替える。認可そのものは別のテストが見ている。
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

const OWNER_UID = 'draw-create-owner';

const authUser = {
  uid: OWNER_UID,
  id: OWNER_UID,
  email: 'host@example.com',
  isAnonymous: false,
  displayName: '司会',
  hostedDomain: 'example.com',
};

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    requireHostUser: async () => ({ user: authUser, profileId: OWNER_UID }),
  };
});

describe.skipIf(!available)('抽選会・ビンゴのルーム作成', () => {
  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'http://localhost';
  });

  /** 抽選リストを作る。名簿・品目は中身も入れる。 */
  async function seedList(options: {
    kind: 'name' | 'number' | 'item';
    labels?: string[];
    numberMin?: number;
    numberMax?: number;
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
        title: `テスト用${options.kind}`,
        kind: options.kind,
        numberMin: options.numberMin ?? null,
        numberMax: options.numberMax ?? null,
        settings: {
          spinIntervalMs: 50,
          spinDurationMs: 2500,
          resultFontSize: 240,
          historyFontSize: 96,
          layout: 'board',
          backgroundAssetId: null,
          openingVideoUrl: null,
        },
        entryCount: options.labels?.length ?? 0,
        createdAt: now,
        updatedAt: now,
      });

    for (const [index, label] of (options.labels ?? []).entries()) {
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
          label,
          imageAssetId: null,
          imageAlt: null,
          createdAt: now,
          updatedAt: now,
        });
    }

    return listId;
  }

  async function readRoom(roomId: string) {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const doc = await getDb().collection('rooms').doc(roomId).get();
    return doc.data() as Record<string, unknown>;
  }

  it('名簿から抽選会のルームを作れる', { timeout: 60_000 }, async () => {
    const listId = await seedList({ kind: 'name', labels: ['山田', '田中', '佐藤'] });
    const { createRoom } = await import('@/application/services/room-service');

    const created = await createRoom({ mode: 'lottery', drawListId: listId });

    expect(created.mode).toBe('lottery');
    // 参加者が来ないモードなので参加 URL は返さない。
    expect(created.joinUrl).toBeNull();
    expect(created.joinToken).toBeNull();
    expect(created.quizTitle).toBe('テスト用name');

    const room = await readRoom(created.roomId);
    expect(room.mode).toBe('lottery');
    // 二次元コードを拾われても入れない。
    expect(room.joinOpen).toBe(false);
    expect(room.quizId).toBeNull();
    expect(room.drawn).toEqual([]);

    const snapshot = room.drawSnapshot as { entries: Array<{ label: string }>; kind: string };
    expect(snapshot.kind).toBe('name');
    expect(snapshot.entries.map((entry) => entry.label)).toEqual(['山田', '田中', '佐藤']);

    // 問題 0 問のクイズを必ず入れる（読み取り経路を分岐だらけにしないため）。
    const quiz = room.quizSnapshot as { questions: unknown[]; title: string };
    expect(quiz.questions).toEqual([]);
    expect(quiz.title).toBe('テスト用name');
  });

  it('数字の範囲からビンゴのルームを作れる', { timeout: 60_000 }, async () => {
    const listId = await seedList({ kind: 'number', numberMin: 1, numberMax: 75 });
    const { createRoom } = await import('@/application/services/room-service');

    const created = await createRoom({ mode: 'bingo', drawListId: listId });
    const room = await readRoom(created.roomId);
    const snapshot = room.drawSnapshot as { entries: Array<{ label: string }> };

    // 範囲だけを保存しておき、ルームへ固めるときに展開する。
    expect(snapshot.entries).toHaveLength(75);
    expect(snapshot.entries[0]?.label).toBe('1');
    expect(snapshot.entries[74]?.label).toBe('75');
  });

  it('抽選会で数字のリストは選べない', { timeout: 60_000 }, async () => {
    // 数字を 1 つずつ引いても「当選者」にならない。
    const listId = await seedList({ kind: 'number', numberMin: 1, numberMax: 10 });
    const { createRoom } = await import('@/application/services/room-service');

    await expect(createRoom({ mode: 'lottery', drawListId: listId })).rejects.toMatchObject({
      code: 'DRAW_LIST_KIND_MISMATCH',
    });
  });

  it('ビンゴで名簿は選べない', { timeout: 60_000 }, async () => {
    const listId = await seedList({ kind: 'name', labels: ['山田'] });
    const { createRoom } = await import('@/application/services/room-service');

    await expect(createRoom({ mode: 'bingo', drawListId: listId })).rejects.toMatchObject({
      code: 'DRAW_LIST_KIND_MISMATCH',
    });
  });

  it('品目のリストはどちらのモードでも使える', { timeout: 60_000 }, async () => {
    // 景品の抽選も、景品ビンゴもありうる。
    const listId = await seedList({ kind: 'item', labels: ['旅行券', '和牛'] });
    const { createRoom } = await import('@/application/services/room-service');

    const lottery = await createRoom({ mode: 'lottery', drawListId: listId });
    const bingo = await createRoom({ mode: 'bingo', drawListId: listId });

    expect(lottery.mode).toBe('lottery');
    expect(bingo.mode).toBe('bingo');
  });

  it('中身が空のリストではルームを作らせない', { timeout: 60_000 }, async () => {
    // 作れてしまうと、会場で「抽選できません」と気づくことになる。
    const listId = await seedList({ kind: 'name', labels: [] });
    const { createRoom } = await import('@/application/services/room-service');

    await expect(createRoom({ mode: 'lottery', drawListId: listId })).rejects.toMatchObject({
      code: 'DRAW_LIST_EMPTY',
    });
  });

  it('他人の抽選リストではルームを作れない', { timeout: 60_000 }, async () => {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const listId = crypto.randomUUID();
    const now = Timestamp.now();
    await getDb()
      .collection('drawLists')
      .doc(listId)
      .set({
        id: listId,
        ownerId: 'someone-else',
        title: '他人の名簿',
        kind: 'name',
        numberMin: null,
        numberMax: null,
        settings: {
          spinIntervalMs: 50,
          spinDurationMs: 2500,
          resultFontSize: 240,
          historyFontSize: 96,
          layout: 'board',
          backgroundAssetId: null,
          openingVideoUrl: null,
        },
        entryCount: 0,
        createdAt: now,
        updatedAt: now,
      });

    const { createRoom } = await import('@/application/services/room-service');

    await expect(createRoom({ mode: 'lottery', drawListId: listId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
