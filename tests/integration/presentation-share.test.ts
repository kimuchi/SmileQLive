// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '@/lib/auth/session';
import type * as AnonymousModule from '@/lib/auth/anonymous';

vi.mock('server-only', () => ({}));

/**
 * 投影用リンクの共有。
 *
 * 会場では投影担当が司会と違う端末で画面を開く。別の人へ URL を渡して
 * 開いてもらうこともある（サブ画面・控室のモニタなど）。
 *
 * ここで固めたいのは 2 つ。
 *   1. **同じリンクを何人が開いても通る。** 1 回使ったら無効、にしない。
 *   2. 開いた人はログイン無しで presenter として登録される。
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

const OWNER = 'share-owner';

const hostUser = {
  uid: OWNER,
  id: OWNER,
  email: 'host@example.com',
  isAnonymous: false,
  displayName: '司会',
  hostedDomain: 'example.com',
};

/** いま「投影用リンクを開いている人」。テストの途中で入れ替える。 */
let visitorUid = 'visitor-1';

vi.mock('@/lib/auth/anonymous', async (importOriginal) => {
  const actual = await importOriginal<typeof AnonymousModule>();
  return {
    ...actual,
    // 投影担当にログインは求めない。匿名ユーザーがその場で用意される想定。
    ensureAuthSession: async () => ({
      uid: visitorUid,
      id: visitorUid,
      email: null,
      isAnonymous: true,
      displayName: null,
      hostedDomain: null,
    }),
  };
});

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    requireHostUser: async () => ({ user: hostUser, profileId: OWNER }),
    requireRoomOwner: async (roomId: string) => {
      const { getDb } = await import('@/infrastructure/firebase/admin');
      const snapshot = await getDb().collection('rooms').doc(roomId).get();
      return { user: hostUser, room: snapshot.data() };
    },
  };
});

describe.skipIf(!available)('投影用リンクの共有', () => {
  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'http://localhost';
  });

  async function seedRoom(): Promise<string> {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const roomId = crypto.randomUUID();
    await getDb()
      .collection('rooms')
      .doc(roomId)
      .set({ id: roomId, ownerId: OWNER, createdAt: Timestamp.now() });
    return roomId;
  }

  /** 発行された URL からトークンだけを取り出す。 */
  function tokenOf(url: string): string {
    return url.split('/').pop() ?? '';
  }

  it('同じリンクを別の人が開いても、どちらも投影を開ける', async () => {
    const roomId = await seedRoom();
    const { exchangePresentationToken, issuePresentationLink } =
      await import('@/application/services/room-service');

    const link = await issuePresentationLink(roomId);
    const token = tokenOf(link.presentationUrl);

    visitorUid = 'visitor-1';
    expect(await exchangePresentationToken(token)).toEqual({ roomId });

    /*
      2 人目。1 回使ったら無効にすると、司会が渡した URL を
      投影担当が開いた時点で他の人が締め出される。
    */
    visitorUid = 'visitor-2';
    expect(await exchangePresentationToken(token)).toEqual({ roomId });

    const { getDb } = await import('@/infrastructure/firebase/admin');
    const members = await getDb().collection('rooms').doc(roomId).collection('members').get();
    const presenters = members.docs
      .map((doc) => doc.data())
      .filter((member) => member.role === 'presenter')
      .map((member) => member.authUserId ?? member.id);

    expect(presenters).toContain('visitor-1');
    expect(presenters).toContain('visitor-2');
    // このファイルで最初に走るテスト。エミュレータへの初回接続ぶん長めに待つ。
  }, 20_000);

  it('同じ人が開き直しても通る（再読み込み・戻る操作）', async () => {
    const roomId = await seedRoom();
    const { exchangePresentationToken, issuePresentationLink } =
      await import('@/application/services/room-service');

    const link = await issuePresentationLink(roomId);
    const token = tokenOf(link.presentationUrl);

    visitorUid = 'visitor-same';
    await exchangePresentationToken(token);
    await expect(exchangePresentationToken(token)).resolves.toEqual({ roomId });
  });

  it('一覧の出し入れは、投影画面へ伝わるように書き込む', async () => {
    /*
      投影画面は「取り直して」と言われたときしか読み直さない。
      ルーム本体だけ書き換えても伝わらず、司会が押しても何も起きない
      （実際にそうなっていた）。staff/progress を触って知らせる。
    */
    const roomId = await seedRoom();
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const db = getDb();

    const progress = db.collection('rooms').doc(roomId).collection('staff').doc('progress');
    await progress.set({ roomId, stateVersion: 3, updatedAt: Timestamp.fromMillis(1_000_000) });

    const { setDrawHistoryOpen } =
      await import('@/infrastructure/firebase/repositories/room-repository');
    await setDrawHistoryOpen(roomId, true);

    const room = (await db.collection('rooms').doc(roomId).get()).data();
    expect(room?.showDrawHistory).toBe(true);

    const after = (await progress.get()).data();
    // 版番号は上げない（司会の二度押し防止を誤検知させないため）。
    expect(after?.stateVersion).toBe(3);
    // 更新時刻は動かす。投影画面はこの変化を合図に読み直す。
    expect(after?.updatedAt?.toMillis()).toBeGreaterThan(1_000_000);
  });

  it('でたらめなトークンは通さない', async () => {
    const { exchangePresentationToken } = await import('@/application/services/room-service');
    await expect(exchangePresentationToken('not-a-real-token')).rejects.toMatchObject({
      code: 'PRESENTATION_LINK_INVALID',
    });
  });
});
