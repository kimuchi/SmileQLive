// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * 抽選会・ビンゴの「引く」まわり。
 *
 * 会場でやり直しの効かない部分なので、実際のトランザクションを
 * エミュレータ上で動かして確かめる。
 *
 * 確かめること:
 *   * 同じものが二度出ない（全部引き切れる）
 *   * 引くものが無くなったら止まる
 *   * 直前の 1 件を取り消して引き直せる
 *   * リセットで最初から引き直せる
 *   * 二度押ししても 1 回しか進まない
 *   * モードをまたいだ操作を受け付けない
 *
 * エミュレータが無ければスキップする（npm test を壊さないため）。
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

const OWNER = 'draw-owner-uid';

describe.skipIf(!available)('抽選会・ビンゴの進行', () => {
  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'http://localhost';
  });

  /** 抽選会またはビンゴのルームを作る。 */
  async function seedDrawRoom(
    roomId: string,
    options: { mode: 'lottery' | 'bingo' | 'quiz'; labels: string[]; phase?: string },
  ) {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const db = getDb();
    const now = Timestamp.now();

    const entries = options.labels.map((label, index) => ({
      id: `e${index + 1}`,
      position: index + 1,
      label,
      image: null,
    }));

    await db
      .collection('rooms')
      .doc(roomId)
      .set({
        id: roomId,
        ownerId: OWNER,
        mode: options.mode,
        quizId: null,
        joinTokenHash: `hash-${roomId}`,
        joinTokenRotatedAt: now,
        phase: options.phase ?? 'draw_ready',
        quizSnapshot: {
          quizId: '',
          title: '抽選テスト',
          settings: {
            showLeaderboard: false,
            showTotalQuestions: false,
            showQuestionBeforeOpen: false,
            soundTheme: 'default',
            leaderboardSize: 0,
          },
          questions: [],
        },
        drawSnapshot: {
          listId: 'list-1',
          title: '抽選テスト',
          kind: options.mode === 'bingo' ? 'number' : 'name',
          entries,
          settings: {
            spinIntervalMs: 50,
            spinDurationMs: 2500,
            resultFontSize: 240,
            historyFontSize: 96,
            layout: 'board',
            backgroundAssetId: null,
            openingVideoUrl: null,
          },
        },
        drawn: [],
        currentQuestionId: null,
        currentQuestionPosition: null,
        phaseStartedAt: now,
        answerDeadlineAt: null,
        stateVersion: 1,
        joinOpen: false,
        maxParticipants: 0,
        participantCount: 0,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      });

    await db
      .collection('rooms')
      .doc(roomId)
      .collection('public')
      .doc('state')
      .set({
        roomId,
        phase: options.phase ?? 'draw_ready',
        stateVersion: 1,
        currentQuestionId: null,
        currentQuestionPosition: null,
        totalQuestions: 0,
        answerDeadlineAt: null,
        joinOpen: false,
        participantCount: 0,
        answeredCount: 0,
        updatedAt: now,
      });
  }

  async function readRoom(roomId: string) {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const doc = await getDb().collection('rooms').doc(roomId).get();
    return doc.data() as {
      phase: string;
      stateVersion: number;
      drawn: Array<{ order: number; entryId: string }>;
    };
  }

  it('引くたびに 1 件ずつ増え、同じものは二度出ない', { timeout: 60_000 }, async () => {
    const roomId = `draw-room-unique-${Date.now()}`;
    const labels = ['山田', '田中', '佐藤', '鈴木', '高橋'];
    await seedDrawRoom(roomId, { mode: 'lottery', labels });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');

    let version = 1;
    for (let index = 0; index < labels.length; index += 1) {
      const result = await transitionRoom({
        roomId,
        action: 'draw_next',
        expectedVersion: version,
        actorUserId: OWNER,
      });
      version = result.stateVersion;
      expect(result.phase).toBe('draw_revealed');
    }

    const room = await readRoom(roomId);
    expect(room.drawn).toHaveLength(labels.length);
    // 全員がちょうど 1 回ずつ出る。
    expect(new Set(room.drawn.map((d) => d.entryId)).size).toBe(labels.length);
    // 通し番号は 1..N の連番。抽選会ではこれがそのまま当選順位になる。
    expect(room.drawn.map((d) => d.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it('引くものが無くなったら止まる', { timeout: 60_000 }, async () => {
    const roomId = `draw-room-empty-${Date.now()}`;
    await seedDrawRoom(roomId, { mode: 'lottery', labels: ['ひとり'] });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');

    const first = await transitionRoom({
      roomId,
      action: 'draw_next',
      expectedVersion: 1,
      actorUserId: OWNER,
    });

    await expect(
      transitionRoom({
        roomId,
        action: 'draw_next',
        expectedVersion: first.stateVersion,
        actorUserId: OWNER,
      }),
    ).rejects.toMatchObject({ code: 'DRAW_POOL_EMPTY' });
  });

  it('直前の 1 件を取り消して引き直せる', { timeout: 60_000 }, async () => {
    const roomId = `draw-room-undo-${Date.now()}`;
    await seedDrawRoom(roomId, { mode: 'bingo', labels: ['1', '2', '3'] });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');

    let version = 1;
    for (let index = 0; index < 2; index += 1) {
      version = (
        await transitionRoom({
          roomId,
          action: 'draw_next',
          expectedVersion: version,
          actorUserId: OWNER,
        })
      ).stateVersion;
    }
    const before = await readRoom(roomId);
    expect(before.drawn).toHaveLength(2);

    const undone = await transitionRoom({
      roomId,
      action: 'undo_draw',
      expectedVersion: version,
      actorUserId: OWNER,
    });
    // 取り消したら結果を出したままにしない（取り消したのに画面に残る、を防ぐ）。
    expect(undone.phase).toBe('draw_ready');

    const after = await readRoom(roomId);
    expect(after.drawn).toHaveLength(1);
    expect(after.drawn[0]).toEqual(before.drawn[0]);

    // 取り消したぶんはまた引ける。
    const again = await transitionRoom({
      roomId,
      action: 'draw_next',
      expectedVersion: undone.stateVersion,
      actorUserId: OWNER,
    });
    expect(again.phase).toBe('draw_revealed');
    expect((await readRoom(roomId)).drawn).toHaveLength(2);
  });

  it('取り消すものが無ければ断る', { timeout: 60_000 }, async () => {
    const roomId = `draw-room-noundo-${Date.now()}`;
    await seedDrawRoom(roomId, { mode: 'lottery', labels: ['山田'] });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');

    await expect(
      transitionRoom({
        roomId,
        action: 'undo_draw',
        expectedVersion: 1,
        actorUserId: OWNER,
      }),
    ).rejects.toMatchObject({ code: 'DRAW_NOTHING_TO_UNDO' });
  });

  it('リセットすると最初から引き直せる', { timeout: 60_000 }, async () => {
    const roomId = `draw-room-reset-${Date.now()}`;
    const labels = ['1', '2', '3'];
    await seedDrawRoom(roomId, { mode: 'bingo', labels });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');

    let version = 1;
    for (let index = 0; index < labels.length; index += 1) {
      version = (
        await transitionRoom({
          roomId,
          action: 'draw_next',
          expectedVersion: version,
          actorUserId: OWNER,
        })
      ).stateVersion;
    }

    const reset = await transitionRoom({
      roomId,
      action: 'reset_draws',
      expectedVersion: version,
      actorUserId: OWNER,
    });
    expect(reset.phase).toBe('draw_ready');
    expect((await readRoom(roomId)).drawn).toEqual([]);

    // 引き直せること（DRAW_POOL_EMPTY にならない）。
    await transitionRoom({
      roomId,
      action: 'draw_next',
      expectedVersion: reset.stateVersion,
      actorUserId: OWNER,
    });
    expect((await readRoom(roomId)).drawn).toHaveLength(1);
  });

  it('二度押ししても 1 回しか進まない', { timeout: 60_000 }, async () => {
    // 司会は会場を見ながら押す。反応が無いと思って二度押すことがある。
    const roomId = `draw-room-double-${Date.now()}`;
    await seedDrawRoom(roomId, { mode: 'lottery', labels: ['あ', 'い', 'う', 'え', 'お'] });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        transitionRoom({
          roomId,
          action: 'draw_next',
          expectedVersion: 1,
          actorUserId: OWNER,
        }),
      ),
    );

    const succeeded = results.filter((result) => result.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);
    expect((await readRoom(roomId)).drawn).toHaveLength(1);
  });

  it('クイズのルームでは抽選の操作を受け付けない', { timeout: 60_000 }, async () => {
    // 画面にはボタンが出ないが、API を直接叩かれる可能性がある。
    const roomId = `draw-room-quizmode-${Date.now()}`;
    await seedDrawRoom(roomId, { mode: 'quiz', labels: ['あ'], phase: 'draw_ready' });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');

    await expect(
      transitionRoom({
        roomId,
        action: 'draw_next',
        expectedVersion: 1,
        actorUserId: OWNER,
      }),
    ).rejects.toMatchObject({ code: 'ROOM_MODE_MISMATCH' });
  });

  it('抽選会のルームではクイズの操作を受け付けない', { timeout: 60_000 }, async () => {
    const roomId = `draw-room-lotterymode-${Date.now()}`;
    await seedDrawRoom(roomId, { mode: 'lottery', labels: ['あ'], phase: 'lobby' });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');

    await expect(
      transitionRoom({
        roomId,
        action: 'show_question',
        expectedVersion: 1,
        questionId: '11111111-1111-4111-8111-111111111111',
        actorUserId: OWNER,
      }),
    ).rejects.toMatchObject({ code: 'ROOM_MODE_MISMATCH' });
  });

  it('抽選会のルームには参加登録できない', { timeout: 60_000 }, async () => {
    // 抽選会・ビンゴは名簿と紙のカードで進める。参加者は来ない。
    // 参加受付を閉じたまま作るので、二次元コードを拾われても入れない。
    const roomId = `draw-room-nojoin-${Date.now()}`;
    await seedDrawRoom(roomId, { mode: 'lottery', labels: ['山田'] });

    const { registerParticipant } = await import('@/infrastructure/firebase/transactions');

    await expect(
      registerParticipant(roomId, 'someone-uid', 'だれか'),
    ).rejects.toMatchObject({ code: 'JOIN_CLOSED' });
  });

  it('終了して再開しても、引いた記録が残り、参加受付は閉じたまま', { timeout: 60_000 }, async () => {
    const roomId = `draw-room-reopen-${Date.now()}`;
    await seedDrawRoom(roomId, { mode: 'lottery', labels: ['あ', 'い', 'う'] });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');
    const { getDb } = await import('@/infrastructure/firebase/admin');

    const drawn = await transitionRoom({
      roomId,
      action: 'draw_next',
      expectedVersion: 1,
      actorUserId: OWNER,
    });
    const finished = await transitionRoom({
      roomId,
      action: 'finish_room',
      expectedVersion: drawn.stateVersion,
      actorUserId: OWNER,
    });
    expect(finished.phase).toBe('finished');

    const reopened = await transitionRoom({
      roomId,
      action: 'reopen_room',
      expectedVersion: finished.stateVersion,
      actorUserId: OWNER,
    });
    // 抽選会にはランキングも問題も無い。引ける状態へ戻す。
    expect(reopened.phase).toBe('draw_ready');

    const room = (await getDb().collection('rooms').doc(roomId).get()).data() as {
      drawn: unknown[];
      joinOpen: boolean;
    };
    expect(room.drawn).toHaveLength(1);
    // 参加者が来ないモードなので、再開しても受付は開けない。
    expect(room.joinOpen).toBe(false);
  });

  it('全部引いたあとも、順位は引いた順のまま', { timeout: 60_000 }, async () => {
    // 抽選会では order が当選順位そのもの。ここが崩れると 1 位が入れ替わる。
    const roomId = `draw-room-order-${Date.now()}`;
    await seedDrawRoom(roomId, { mode: 'lottery', labels: ['a', 'b', 'c', 'd'] });

    const { transitionRoom } = await import('@/infrastructure/firebase/transactions');

    let version = 1;
    const picked: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      version = (
        await transitionRoom({
          roomId,
          action: 'draw_next',
          expectedVersion: version,
          actorUserId: OWNER,
        })
      ).stateVersion;
      const room = await readRoom(roomId);
      picked.push(room.drawn[room.drawn.length - 1]!.entryId);
    }

    const room = await readRoom(roomId);
    expect(room.drawn.map((d) => d.entryId)).toEqual(picked);
    expect(room.drawn.map((d) => d.order)).toEqual([1, 2, 3, 4]);
  });
});
