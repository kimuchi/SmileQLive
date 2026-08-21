// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '@/lib/auth/session';

vi.mock('server-only', () => ({}));

/**
 * ルーレット。
 *
 * ここで固めたいのは次の 4 つ。
 *   1. **スタートでは当たりを決めない。** 回し始めただけの状態を作る。
 *      先に決めて渡すと、投影画面のどこかから結果が読めてしまう。
 *   2. ストップで初めて決めて記録する。
 *   3. 引いたものを**母集団から外さない**（円盤の扇は減らない）。
 *      外すと重みの意味が無くなり、最後は残り 1 つが必ず出る。
 *   4. 重みが効く。広い扇のほうが当たりやすい。
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

const OWNER = 'roulette-owner';

const authUser = {
  uid: OWNER,
  id: OWNER,
  email: 'host@example.com',
  isAnonymous: false,
  displayName: '司会',
  hostedDomain: 'example.com',
};

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    requireHostUser: async () => ({ user: authUser, profileId: OWNER }),
    requireRoomMember: async (roomId: string) => {
      const { getDb } = await import('@/infrastructure/firebase/admin');
      const snapshot = await getDb().collection('rooms').doc(roomId).get();
      return {
        user: authUser,
        member: { id: OWNER, roomId, role: 'host', lastSeenAt: null },
        room: snapshot.data(),
      };
    },
    requireRoomOwner: async (roomId: string) => {
      const { getDb } = await import('@/infrastructure/firebase/admin');
      const snapshot = await getDb().collection('rooms').doc(roomId).get();
      return { user: authUser, room: snapshot.data() };
    },
  };
});

describe.skipIf(!available)('ルーレット', () => {
  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'http://localhost';
  });

  /** 重み付きの抽選リストを作り、そのルームを開く。 */
  async function seedRoom(weights: Array<{ label: string; weight: number }>) {
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
        ownerId: OWNER,
        title: 'ルーレット',
        kind: 'weighted',
        numberMin: null,
        numberMax: null,
        settings: {
          spinIntervalMs: 50,
          spinDurationMs: 2500,
          stopDurationMs: 4000,
          resultFontSize: 240,
          historyFontSize: 96,
          layout: 'result',
          backgroundAssetId: null,
          openingVideoUrl: null,
        },
        entryCount: weights.length,
        createdAt: now,
        updatedAt: now,
      });

    for (const [index, entry] of weights.entries()) {
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
          label: entry.label,
          imageAssetId: null,
          imageAlt: null,
          weight: entry.weight,
          createdAt: now,
          updatedAt: now,
        });
    }

    const { createRoom } = await import('@/application/services/room-service');
    return createRoom({ mode: 'roulette', drawListId: listId });
  }

  async function readRoom(roomId: string) {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const doc = await getDb().collection('rooms').doc(roomId).get();
    return doc.data() as { phase: string; stateVersion: number; drawn: Array<{ entryId: string }> };
  }

  async function run(roomId: string, action: string) {
    const { transitionRoom } = await import('@/application/services/room-service');
    const room = await readRoom(roomId);
    return transitionRoom(roomId, {
      action: action as 'open_draw',
      expectedVersion: room.stateVersion,
    });
  }

  it('スタートでは当たりを決めない', { timeout: 60_000 }, async () => {
    // ここで決めてしまうと、回している最中に結果が読める余地ができる。
    const created = await seedRoom([
      { label: '大当たり', weight: 1 },
      { label: 'はずれ', weight: 9 },
    ]);

    await run(created.roomId, 'open_draw');
    await run(created.roomId, 'start_spin');

    const room = await readRoom(created.roomId);
    expect(room.phase).toBe('draw_spinning');
    expect(room.drawn).toEqual([]);
  });

  it('ストップで初めて記録される', { timeout: 60_000 }, async () => {
    const created = await seedRoom([
      { label: '大当たり', weight: 1 },
      { label: 'はずれ', weight: 9 },
    ]);

    await run(created.roomId, 'open_draw');
    await run(created.roomId, 'start_spin');
    await run(created.roomId, 'draw_next');

    const room = await readRoom(created.roomId);
    expect(room.phase).toBe('draw_revealed');
    expect(room.drawn).toHaveLength(1);
  });

  it('同じ項目が何度でも出る（母集団から外さない）', { timeout: 60_000 }, async () => {
    // 円盤の扇は回すたびに減らない。減らすと最後は残り 1 つが必ず出る。
    const created = await seedRoom([{ label: 'ひとつだけ', weight: 1 }]);

    await run(created.roomId, 'open_draw');
    for (let i = 0; i < 3; i += 1) {
      await run(created.roomId, 'start_spin');
      await run(created.roomId, 'draw_next');
    }

    const room = await readRoom(created.roomId);
    expect(room.drawn).toHaveLength(3);
  });

  it('残りは減らない', { timeout: 60_000 }, async () => {
    // 「残り 0」になると司会画面が終了を促してしまう。
    const created = await seedRoom([
      { label: 'A', weight: 1 },
      { label: 'B', weight: 1 },
    ]);
    const { getStaffSnapshot } = await import('@/application/services/room-service');

    await run(created.roomId, 'open_draw');
    await run(created.roomId, 'start_spin');
    await run(created.roomId, 'draw_next');

    const snapshot = await getStaffSnapshot(created.roomId, 'host');
    expect(snapshot.draw?.remainingCount).toBe(2);
  });

  it('重みが効く', { timeout: 60_000 }, async () => {
    // 広い扇のほうが当たりやすくないと、会場に見えている円盤と食い違う。
    const created = await seedRoom([
      { label: 'せまい', weight: 1 },
      { label: 'ひろい', weight: 49 },
    ]);

    await run(created.roomId, 'open_draw');
    const labels: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      await run(created.roomId, 'start_spin');
      await run(created.roomId, 'draw_next');
    }

    const { getStaffSnapshot } = await import('@/application/services/room-service');
    const snapshot = await getStaffSnapshot(created.roomId, 'host');
    for (const record of snapshot.draw?.drawn ?? []) {
      const entry = snapshot.draw?.entries.find((candidate) => candidate.id === record.entryId);
      labels.push(entry?.label ?? '');
    }

    // 49:1。40 回引いて「せまい」が半分以上出たら、重みが効いていない。
    expect(labels.filter((label) => label === 'ひろい').length).toBeGreaterThan(28);
  });

  it('ルーレットで名簿のリストも回せる', { timeout: 60_000 }, async () => {
    // 重みを持たないリストでも回せる（すべて同じ幅になる）。
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const now = Timestamp.now();
    const listId = crypto.randomUUID();
    await getDb()
      .collection('drawLists')
      .doc(listId)
      .set({
        id: listId,
        ownerId: OWNER,
        title: '名簿',
        kind: 'name',
        numberMin: null,
        numberMax: null,
        settings: {
          spinIntervalMs: 50,
          spinDurationMs: 2500,
          stopDurationMs: 4000,
          resultFontSize: 240,
          historyFontSize: 96,
          layout: 'result',
          backgroundAssetId: null,
          openingVideoUrl: null,
        },
        entryCount: 1,
        createdAt: now,
        updatedAt: now,
      });
    const entryId = crypto.randomUUID();
    await getDb().collection('drawLists').doc(listId).collection('entries').doc(entryId).set({
      id: entryId,
      listId,
      position: 1,
      label: '山田',
      imageAssetId: null,
      imageAlt: null,
      createdAt: now,
      updatedAt: now,
    });

    const { createRoom } = await import('@/application/services/room-service');
    const created = await createRoom({ mode: 'roulette', drawListId: listId });

    expect(created.mode).toBe('roulette');
  });

  it('数字のリストはルーレットで使えない', { timeout: 60_000 }, async () => {
    // 1〜75 の円盤には意味が無い。ビンゴの球のための種類。
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const now = Timestamp.now();
    const listId = crypto.randomUUID();
    await getDb()
      .collection('drawLists')
      .doc(listId)
      .set({
        id: listId,
        ownerId: OWNER,
        title: '数字',
        kind: 'number',
        numberMin: 1,
        numberMax: 10,
        settings: {
          spinIntervalMs: 50,
          spinDurationMs: 2500,
          stopDurationMs: 4000,
          resultFontSize: 240,
          historyFontSize: 96,
          layout: 'board',
          backgroundAssetId: null,
          openingVideoUrl: null,
        },
        entryCount: 10,
        createdAt: now,
        updatedAt: now,
      });

    const { createRoom } = await import('@/application/services/room-service');
    await expect(createRoom({ mode: 'roulette', drawListId: listId })).rejects.toMatchObject({
      code: 'DRAW_LIST_KIND_MISMATCH',
    });
  });
});
