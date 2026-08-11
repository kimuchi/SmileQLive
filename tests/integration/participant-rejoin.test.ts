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

  it('2 回登録しても同じ参加者になり、人数も増えない', async () => {
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

  it('別の端末（別の uid）は別の参加者になる', async () => {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { registerParticipant } = await import('@/infrastructure/firebase/transactions');

    const other = await registerParticipant(roomId, 'another-device-uid', 'はなこ');
    expect(other.alreadyJoined).toBe(false);

    const room = await getDb().collection('rooms').doc(roomId).get();
    expect(room.data()?.participantCount).toBe(2);
  });
});
