// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * 終了したクイズの再開と、回答時間の延長。
 *
 * どちらも締切・得点という「戻せないもの」に触れるため、
 * 実際のトランザクションをエミュレータ上で動かして確かめる。
 *
 * 確かめること:
 *   * 再開しても得点・回答が消えない
 *   * 再開すると参加受付が戻る（同じ二次元コードで戻ってこられる）
 *   * 終了したままでは進行操作ができない
 *   * 延長は残り時間へ足される（締切後に押した場合は今から数え直す）
 *   * 延長できるのは回答受付中だけ
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

const OWNER = 'reopen-owner-uid';
const QUESTION_ID = '11111111-1111-4111-8111-111111111111';

type RoomSeed = {
  phase: string;
  stateVersion: number;
  currentQuestionId: string | null;
  currentQuestionPosition: number | null;
  answerDeadlineAtMs: number | null;
  finishedAtMs: number | null;
  joinOpen: boolean;
};

describe.skipIf(!available)('終了からの再開と回答時間の延長', () => {
  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'http://localhost';
  });

  /** 指定した状態のルームを作る。問題は 1 問だけ持たせる。 */
  async function seedRoom(roomId: string, seed: RoomSeed) {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const db = getDb();
    const now = Timestamp.now();

    await db
      .collection('rooms')
      .doc(roomId)
      .set({
        id: roomId,
        ownerId: OWNER,
        quizId: 'quiz-reopen',
        joinTokenHash: 'hash',
        joinTokenRotatedAt: now,
        phase: seed.phase,
        quizSnapshot: {
          quizId: 'quiz-reopen',
          title: '再開の確認',
          settings: { showLeaderboard: true, soundTheme: 'default', leaderboardSize: 10 },
          questions: [
            {
              id: QUESTION_ID,
              position: 1,
              text: '確認用の問題',
              image: null,
              revealImage: null,
              timeLimitSeconds: 20,
              points: 100,
              explanation: null,
              type: 'choice',
              choices: [
                {
                  id: '22222222-2222-4222-8222-222222222222',
                  position: 1,
                  text: 'あ',
                  image: null,
                  isCorrect: true,
                },
                {
                  id: '33333333-3333-4333-8333-333333333333',
                  position: 2,
                  text: 'い',
                  image: null,
                  isCorrect: false,
                },
              ],
            },
          ],
        },
        currentQuestionId: seed.currentQuestionId,
        currentQuestionPosition: seed.currentQuestionPosition,
        phaseStartedAt: now,
        answerDeadlineAt:
          seed.answerDeadlineAtMs === null ? null : Timestamp.fromMillis(seed.answerDeadlineAtMs),
        stateVersion: seed.stateVersion,
        joinOpen: seed.joinOpen,
        maxParticipants: 200,
        participantCount: 1,
        createdAt: now,
        updatedAt: now,
        finishedAt: seed.finishedAtMs === null ? null : Timestamp.fromMillis(seed.finishedAtMs),
      });

    await db
      .collection('rooms')
      .doc(roomId)
      .collection('public')
      .doc('state')
      .set({
        roomId,
        phase: seed.phase,
        stateVersion: seed.stateVersion,
        currentQuestionId: seed.currentQuestionId,
        currentQuestionPosition: seed.currentQuestionPosition,
        totalQuestions: 1,
        answerDeadlineAt:
          seed.answerDeadlineAtMs === null ? null : Timestamp.fromMillis(seed.answerDeadlineAtMs),
        joinOpen: seed.joinOpen,
        participantCount: 1,
        answeredCount: 0,
        updatedAt: now,
      });

    return db;
  }

  it('再開すると得点を残したまま続きへ戻れる', { timeout: 20000 }, async () => {
    const roomId = `reopen-room-${Date.now()}`;
    const db = await seedRoom(roomId, {
      phase: 'finished',
      stateVersion: 7,
      currentQuestionId: QUESTION_ID,
      currentQuestionPosition: 1,
      answerDeadlineAtMs: null,
      finishedAtMs: Date.now(),
      joinOpen: false,
    });

    // 得点を持った参加者。再開しても消えてはいけない。
    const { Timestamp } = await import('firebase-admin/firestore');
    await db
      .collection('rooms')
      .doc(roomId)
      .collection('members')
      .doc('scored-participant')
      .set({
        id: 'scored-participant',
        roomId,
        authUserId: 'scored-participant',
        role: 'participant',
        nickname: 'たろう',
        nicknameLower: 'たろう',
        joinedAt: Timestamp.now(),
        lastSeenAt: Timestamp.now(),
        isActive: true,
        totalPoints: 250,
        correctCount: 2,
        correctElapsedMsTotal: 4200,
      });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');
    const result = await transitionRoom({
      roomId,
      action: 'reopen_room',
      expectedVersion: 7,
      actorUserId: OWNER,
    });

    // 出題済みだったのでランキングへ戻る。ここからは出題も終了も選べる。
    expect(result.phase).toBe('scoreboard');
    expect(result.stateVersion).toBe(8);

    const room = (await db.collection('rooms').doc(roomId).get()).data();
    expect(room?.finishedAt).toBeNull();
    // 終了時に閉じた参加受付が戻る（同じ二次元コードで戻ってこられる）。
    expect(room?.joinOpen).toBe(true);

    const member = (
      await db.collection('rooms').doc(roomId).collection('members').doc('scored-participant').get()
    ).data();
    expect(member?.totalPoints).toBe(250);
    expect(member?.correctCount).toBe(2);

    // 参加者・投影が見る公開状態にも反映される。
    const publicState = (
      await db.collection('rooms').doc(roomId).collection('public').doc('state').get()
    ).data();
    expect(publicState?.phase).toBe('scoreboard');
    expect(publicState?.joinOpen).toBe(true);
  });

  it('1 問も出していない状態で終了した場合は待機中へ戻る', { timeout: 20000 }, async () => {
    const roomId = `reopen-empty-${Date.now()}`;
    await seedRoom(roomId, {
      phase: 'finished',
      stateVersion: 1,
      currentQuestionId: null,
      currentQuestionPosition: null,
      answerDeadlineAtMs: null,
      finishedAtMs: Date.now(),
      joinOpen: false,
    });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');
    const result = await transitionRoom({
      roomId,
      action: 'reopen_room',
      expectedVersion: 1,
      actorUserId: OWNER,
    });

    expect(result.phase).toBe('lobby');
  });

  it('終了したままでは進行操作を受け付けない', { timeout: 20000 }, async () => {
    const roomId = `reopen-guard-${Date.now()}`;
    await seedRoom(roomId, {
      phase: 'finished',
      stateVersion: 3,
      currentQuestionId: QUESTION_ID,
      currentQuestionPosition: 1,
      answerDeadlineAtMs: null,
      finishedAtMs: Date.now(),
      joinOpen: false,
    });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');
    await expect(
      transitionRoom({
        roomId,
        action: 'show_question',
        expectedVersion: 3,
        questionId: QUESTION_ID,
        actorUserId: OWNER,
      }),
    ).rejects.toMatchObject({ code: 'ROOM_FINISHED' });
  });

  it('延長すると残り時間へ足される', { timeout: 20000 }, async () => {
    const roomId = `extend-room-${Date.now()}`;
    const deadlineMs = Date.now() + 30_000;
    const db = await seedRoom(roomId, {
      phase: 'question_open',
      stateVersion: 4,
      currentQuestionId: QUESTION_ID,
      currentQuestionPosition: 1,
      answerDeadlineAtMs: deadlineMs,
      finishedAtMs: null,
      joinOpen: true,
    });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');
    const result = await transitionRoom({
      roomId,
      action: 'extend_deadline',
      expectedVersion: 4,
      extendSeconds: 30,
      actorUserId: OWNER,
    });

    // フェーズは変わらない。締切だけが伸びる。
    expect(result.phase).toBe('question_open');
    expect(result.stateVersion).toBe(5);

    const room = (await db.collection('rooms').doc(roomId).get()).data();
    const extendedMs = room?.answerDeadlineAt?.toMillis() ?? 0;
    // 元の締切 + 30 秒（実行にかかる時間の分だけ幅を持たせる）。
    expect(extendedMs).toBeGreaterThanOrEqual(deadlineMs + 29_000);
    expect(extendedMs).toBeLessThanOrEqual(deadlineMs + 31_000);
  });

  it('締切を過ぎてから延長した場合は押した時点から数え直す', { timeout: 20000 }, async () => {
    const roomId = `extend-late-${Date.now()}`;
    const passedDeadlineMs = Date.now() - 60_000;
    const db = await seedRoom(roomId, {
      phase: 'question_open',
      stateVersion: 2,
      currentQuestionId: QUESTION_ID,
      currentQuestionPosition: 1,
      answerDeadlineAtMs: passedDeadlineMs,
      finishedAtMs: null,
      joinOpen: true,
    });

    const before = Date.now();
    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');
    await transitionRoom({
      roomId,
      action: 'extend_deadline',
      expectedVersion: 2,
      extendSeconds: 10,
      actorUserId: OWNER,
    });

    const room = (await db.collection('rooms').doc(roomId).get()).data();
    const extendedMs = room?.answerDeadlineAt?.toMillis() ?? 0;
    // 過ぎた締切へ足すと過去のままになってしまう。今から 10 秒後になっていること。
    expect(extendedMs).toBeGreaterThanOrEqual(before + 9_000);
    expect(extendedMs).toBeLessThanOrEqual(Date.now() + 11_000);
  });

  it('回答を締め切ったあとは延長できない', { timeout: 20000 }, async () => {
    const roomId = `extend-locked-${Date.now()}`;
    await seedRoom(roomId, {
      phase: 'question_locked',
      stateVersion: 5,
      currentQuestionId: QUESTION_ID,
      currentQuestionPosition: 1,
      answerDeadlineAtMs: null,
      finishedAtMs: null,
      joinOpen: true,
    });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');
    await expect(
      transitionRoom({
        roomId,
        action: 'extend_deadline',
        expectedVersion: 5,
        extendSeconds: 30,
        actorUserId: OWNER,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('範囲外の秒数は受け付けない', { timeout: 20000 }, async () => {
    const roomId = `extend-range-${Date.now()}`;
    await seedRoom(roomId, {
      phase: 'question_open',
      stateVersion: 1,
      currentQuestionId: QUESTION_ID,
      currentQuestionPosition: 1,
      answerDeadlineAtMs: Date.now() + 10_000,
      finishedAtMs: null,
      joinOpen: true,
    });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');
    await expect(
      transitionRoom({
        roomId,
        action: 'extend_deadline',
        expectedVersion: 1,
        extendSeconds: 100_000,
        actorUserId: OWNER,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
