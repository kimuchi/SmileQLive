// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * 同じ端末で同じ二次元コードを読み直したとき、同一人物として扱われること。
 *
 * 参加者は匿名認証で、端末に残る匿名利用者（uid）が本人の識別子になる。
 * 参加者行は `rooms/{roomId}/members/{uid}` に置かれるため、
 * 同じ uid で登録し直しても新しい参加者は増えない。
 * ここでは**実際のトランザクション**をエミュレータ上で動かして確かめる。
 *
 * エミュレータが無ければスキップする（npm test を壊さないため）。
 *   npx firebase-tools@15 emulators:start --only firestore --project smileq-live-emulator
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

describe.skipIf(!available)('同じ端末での再参加', () => {
  const roomId = `rejoin-room-${Date.now()}`;
  const uid = 'rejoin-participant-uid';

  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'http://localhost';
  });

  // 初回はエミュレータへの接続確立に時間がかかる。既定の 5 秒では足りないことがある。
  it('2 回登録しても同じ参加者になり、人数も増えない', { timeout: 20000 }, async () => {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { registerParticipant } = await import('@/infrastructure/firebase/transactions');
    const { Timestamp } = await import('firebase-admin/firestore');

    const db = getDb();
    const now = Timestamp.now();
    await db
      .collection('rooms')
      .doc(roomId)
      .set({
        id: roomId,
        ownerId: 'owner-uid',
        quizId: 'quiz-x',
        joinTokenHash: 'hash',
        joinTokenRotatedAt: now,
        phase: 'lobby',
        quizSnapshot: { quizId: 'quiz-x', title: 'テスト', settings: {}, questions: [] },
        currentQuestionId: null,
        currentQuestionPosition: null,
        phaseStartedAt: null,
        answerDeadlineAt: null,
        stateVersion: 0,
        joinOpen: true,
        maxParticipants: 100,
        participantCount: 0,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      });

    const first = await registerParticipant(roomId, uid, 'たろう');
    expect(first.alreadyJoined).toBe(false);
    expect(first.participantId).toBe(uid);

    // 二次元コードを読み直して、別のニックネームを入れた場合。
    const second = await registerParticipant(roomId, uid, 'べつのなまえ');
    expect(second.alreadyJoined).toBe(true);
    expect(second.participantId).toBe(uid);
    // 最初のニックネームを保つ（同じ人の表示名が途中で変わらない）。
    expect(second.nickname).toBe('たろう');

    const room = await db.collection('rooms').doc(roomId).get();
    expect(room.data()?.participantCount).toBe(1);

    const members = await db.collection('rooms').doc(roomId).collection('members').get();
    expect(members.size).toBe(1);
  });

  it('別の端末（別の uid）は別の参加者になる', { timeout: 20000 }, async () => {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { registerParticipant } = await import('@/infrastructure/firebase/transactions');

    const other = await registerParticipant(roomId, 'another-device-uid', 'はなこ');
    expect(other.alreadyJoined).toBe(false);

    const room = await getDb().collection('rooms').doc(roomId).get();
    expect(room.data()?.participantCount).toBe(2);
  });

  /**
   * 開場直後は全員が同時に二次元コードを読む。
   *
   * 以前はここをトランザクションで囲み、その中で `rooms/{id}` を読んで
   * 人数を書き戻していた。同じドキュメントを読んで書くトランザクションは
   * 同時に走ると片方がやり直しになるため、**500 人で試したところ
   * 499 人が入れなかった**（tests/load/scale.test.ts）。
   * ここでは軽い人数で同じ性質を見張る。会場規模は npm run load:test で確かめる。
   */
  it('同時に来ても全員が入れて、人数がずれない', { timeout: 60000 }, async () => {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { registerParticipant } = await import('@/infrastructure/firebase/transactions');

    const burstRoomId = `${roomId}-burst`;
    const people = 60;

    const db = getDb();
    const { Timestamp } = await import('firebase-admin/firestore');
    const now = Timestamp.now();
    await db
      .collection('rooms')
      .doc(burstRoomId)
      .set({
        id: burstRoomId,
        ownerId: 'owner-uid',
        quizId: 'quiz-x',
        joinTokenHash: 'hash-burst',
        joinTokenRotatedAt: now,
        phase: 'lobby',
        quizSnapshot: { quizId: 'quiz-x', title: 'テスト', settings: {}, questions: [] },
        currentQuestionId: null,
        currentQuestionPosition: null,
        phaseStartedAt: null,
        answerDeadlineAt: null,
        stateVersion: 0,
        joinOpen: true,
        maxParticipants: people + 10,
        participantCount: 0,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      });

    const results = await Promise.allSettled(
      Array.from({ length: people }, (_, index) =>
        registerParticipant(burstRoomId, `burst-uid-${index}`, `参加者${index}`),
      ),
    );

    const rejected = results.filter((result) => result.status === 'rejected');
    // 1 人でも弾かれたら会場では事故になる。
    expect(rejected).toHaveLength(0);

    const members = await db
      .collection('rooms')
      .doc(burstRoomId)
      .collection('members')
      .count()
      .get();
    expect(members.data().count).toBe(people);

    const room = await db.collection('rooms').doc(burstRoomId).get();
    // 表示に使う人数が実数と食い違わないこと。
    expect(room.data()?.participantCount).toBe(people);
  });
});
