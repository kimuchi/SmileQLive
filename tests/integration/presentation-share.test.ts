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
  });

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

  it('でたらめなトークンは通さない', async () => {
    const { exchangePresentationToken } = await import('@/application/services/room-service');
    await expect(exchangePresentationToken('not-a-real-token')).rejects.toMatchObject({
      code: 'PRESENTATION_LINK_INVALID',
    });
  });
});
