// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '@/lib/auth/session';

vi.mock('server-only', () => ({}));

/**
 * 投影画面が自分で参加用の二次元コードを出せること。
 *
 * 以前は参加 URL の平文トークンをサーバーが持っていなかったため、
 * 司会と違う端末（会場の投影用パソコン）で開くと二次元コードを出せず、
 * その場で URL を貼り付けてもらう必要があった。当日いちばん詰まる場所だったので、
 * ルームへ平文を持たせ、Snapshot が投影担当にも返すようにしてある。
 *
 * ここで固めたいのは次の 3 つ。
 *   1. 司会にも投影担当にも参加 URL が返ること。
 *   2. 参加者が来ないモード（抽選会・ビンゴ）では返さないこと。
 *   3. 平文を持たない古いルームでは null になり、画面側の予備手段へ落ちること。
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

const OWNER = 'join-url-owner';

const authUser = {
  uid: OWNER,
  id: OWNER,
  email: 'host@example.com',
  isAnonymous: false,
  displayName: '司会',
  hostedDomain: 'example.com',
};

/** 役割の検証は別のテストが見ている。ここでは中身の受け渡しだけを確かめる。 */
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
  };
});

describe.skipIf(!available)('投影画面へ渡す参加 URL', () => {
  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'https://quiz.example.com';
  });

  /** ルームを直接置く。トークンの持ち方だけを変えて比べたいので、作成 API は通さない。 */
  async function seedRoom(options: {
    joinToken: string | null;
    mode?: 'quiz' | 'lottery';
    joinOpen?: boolean;
    alwaysShowJoinCode?: boolean;
  }) {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const db = getDb();
    const now = Timestamp.now();
    const roomId = crypto.randomUUID();

    await db
      .collection('rooms')
      .doc(roomId)
      .set({
        id: roomId,
        ownerId: OWNER,
        mode: options.mode ?? 'quiz',
        quizId: 'quiz-join-url',
        joinTokenHash: 'hash',
        ...(options.joinToken !== null ? { joinToken: options.joinToken } : {}),
        joinTokenRotatedAt: now,
        phase: 'lobby',
        quizSnapshot: {
          quizId: 'quiz-join-url',
          title: '参加URLの確認',
          settings: {
            showLeaderboard: true,
            showTotalQuestions: true,
            showQuestionBeforeOpen: false,
            alwaysShowJoinCode: options.alwaysShowJoinCode ?? false,
            soundTheme: 'default',
            leaderboardSize: 10,
          },
          questions: [],
        },
        drawSnapshot: null,
        drawn: [],
        currentQuestionId: null,
        currentQuestionPosition: null,
        phaseStartedAt: null,
        answerDeadlineAt: null,
        stateVersion: 0,
        joinOpen: options.joinOpen ?? true,
        maxParticipants: 500,
        participantCount: 0,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      });

    await db.collection('rooms').doc(roomId).collection('members').doc(OWNER).set({
      id: OWNER,
      roomId,
      authUserId: OWNER,
      role: 'host',
      nickname: null,
      nicknameLower: null,
      joinedAt: now,
      lastSeenAt: now,
      isActive: true,
    });

    return roomId;
  }

  it('投影担当にも参加 URL を返す', { timeout: 60_000 }, async () => {
    // ここが本題。投影担当へ返さないと、会場で URL を貼り付けることになる。
    const roomId = await seedRoom({ joinToken: 'token-for-presenter' });
    const { getStaffSnapshot } = await import('@/application/services/room-service');

    const snapshot = await getStaffSnapshot(roomId, 'presenter');

    expect(snapshot.joinUrl).toBe('https://quiz.example.com/j/token-for-presenter');
    // 参加者一覧は投影担当へ渡さない。
    expect(snapshot.participants).toBeUndefined();
  });

  it('司会にも同じ参加 URL を返す', { timeout: 60_000 }, async () => {
    const roomId = await seedRoom({ joinToken: 'token-for-host' });
    const { getStaffSnapshot } = await import('@/application/services/room-service');

    const snapshot = await getStaffSnapshot(roomId, 'host');

    expect(snapshot.joinUrl).toBe('https://quiz.example.com/j/token-for-host');
  });

  it('抽選会のルームでは参加 URL を返さない', { timeout: 60_000 }, async () => {
    // 参加者が来ないモード。二次元コードを出しても入れない。
    const roomId = await seedRoom({
      joinToken: 'token-should-not-leak',
      mode: 'lottery',
      joinOpen: false,
    });
    const { getStaffSnapshot } = await import('@/application/services/room-service');

    const snapshot = await getStaffSnapshot(roomId, 'presenter');

    expect(snapshot.joinUrl).toBeNull();
  });

  it('平文を持たない古いルームでは null', { timeout: 60_000 }, async () => {
    // 画面側は貼り付けの予備手段へ落ちる。ここで落ちないと二次元コードが空になる。
    const roomId = await seedRoom({ joinToken: null });
    const { getStaffSnapshot } = await import('@/application/services/room-service');

    const snapshot = await getStaffSnapshot(roomId, 'presenter');

    expect(snapshot.joinUrl).toBeNull();
  });

  it('二次元コードを出し続ける設定が投影画面まで届く', { timeout: 60_000 }, async () => {
    const roomId = await seedRoom({ joinToken: 'token-always', alwaysShowJoinCode: true });
    const { getStaffSnapshot } = await import('@/application/services/room-service');

    const snapshot = await getStaffSnapshot(roomId, 'presenter');

    expect(snapshot.alwaysShowJoinCode).toBe(true);
  });

  it('既定では出し続けない', { timeout: 60_000 }, async () => {
    const roomId = await seedRoom({ joinToken: 'token-default' });
    const { getStaffSnapshot } = await import('@/application/services/room-service');

    const snapshot = await getStaffSnapshot(roomId, 'presenter');

    expect(snapshot.alwaysShowJoinCode).toBe(false);
  });
});
