// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * 会場規模（500 人）の負荷検証。
 *
 *   npm run load:test              … 既定の 500 人
 *   LOAD_PARTICIPANTS=1000 npm run load:test
 *
 * 通常の `npm test` には含めない（重く、エミュレータが要る）。
 * docs/OPERATIONS.md の「同時接続の目安」を数字で裏づけるのがこのファイルの役目。
 *
 * ここで見ているのは **1 ドキュメントへの集中**。会場では次の 3 つが同時に起きる。
 *
 *   1. 開場直後に全員が二次元コードを読む   → 参加登録が一斉に走る
 *   2. 出題ごとに全員が同時に回答する       → 回答登録が一斉に走る
 *   3. 正解発表でみんなの画面が一斉に更新   → Snapshot 取得が一斉に走る
 *   4. 「今から投票です」で全員が同時に押す → 投票が一斉に走る
 *
 * Firestore は 1 ドキュメントあたり毎秒 1 回程度の書き込みしか想定していない。
 * トランザクションが同じドキュメントを読んで書くと、同時実行のたびに
 * やり直し（ABORTED）が起き、人数の二乗で悪化する。
 * したがって「登録・回答が 1 件も落ちないこと」を実測で確かめる。
 *
 * エミュレータが無ければスキップする。
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

/** 会場規模。既定は仕様の目標である 500 人。 */
const PARTICIPANTS = Number(process.env.LOAD_PARTICIPANTS ?? 500);
/** 比較用の小規模。読み取り量が人数に比例していないかを見るために使う。 */
const SMALL = 25;

const OWNER = 'load-owner-uid';
const ROOM_ID = 'room-load';
const QUESTION_ID = '11111111-1111-4111-8111-111111111111';
const CHOICE_A = '22222222-2222-4222-8222-222222222222';
const CHOICE_B = '33333333-3333-4333-8333-333333333333';
const OPTION_A = '44444444-4444-4444-8444-444444444444';
const OPTION_B = '55555555-5555-4555-8555-555555555555';

type Outcome = { ok: number; failed: Map<string, number> };

function tally(results: PromiseSettledResult<unknown>[]): Outcome {
  const failed = new Map<string, number>();
  let ok = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      ok += 1;
      continue;
    }
    const reason = result.reason as { code?: unknown; message?: unknown };
    const key =
      typeof reason?.code === 'string'
        ? reason.code
        : typeof reason?.code === 'number'
          ? `grpc:${reason.code}`
          : String(reason?.message ?? reason).slice(0, 60);
    failed.set(key, (failed.get(key) ?? 0) + 1);
  }
  return { ok, failed };
}

function describeFailures(outcome: Outcome): string {
  if (outcome.failed.size === 0) {
    return 'なし';
  }
  return [...outcome.failed].map(([code, count]) => `${code}×${count}`).join(', ');
}

/** ミリ秒を読みやすく。 */
function ms(value: number): string {
  return `${value.toFixed(0)}ms`;
}

describe.skipIf(!available)(`会場規模の負荷（${PARTICIPANTS}人）`, () => {
  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'http://localhost';
  });

  async function db() {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    return getDb();
  }

  /** ルーム配下を消してから作り直す。 */
  async function resetRoom(options: {
    phase: string;
    deadlineInMs: number | null;
    /** 投票のルームにする（投票の負荷を測るとき）。 */
    poll?: boolean;
  }) {
    const { Timestamp } = await import('firebase-admin/firestore');
    const store = await db();
    const room = store.collection('rooms').doc(ROOM_ID);

    // 前回の実行が残っていると人数が合わなくなる。配下ごと消す。
    for (const sub of ['members', 'answers', 'events', 'votes']) {
      const docs = await room.collection(sub).limit(2000).get();
      for (let index = 0; index < docs.docs.length; index += 400) {
        const batch = store.batch();
        for (const doc of docs.docs.slice(index, index + 400)) {
          batch.delete(doc.ref);
        }
        await batch.commit();
      }
    }

    const now = Timestamp.now();
    await room.set({
      id: ROOM_ID,
      ownerId: OWNER,
      quizId: 'quiz-load',
      joinTokenHash: 'load-hash',
      joinTokenRotatedAt: now,
      phase: options.phase,
      quizSnapshot: {
        quizId: 'quiz-load',
        title: '負荷検証',
        settings: { showLeaderboard: true, soundTheme: 'default', leaderboardSize: 10 },
        questions: [
          {
            id: QUESTION_ID,
            position: 1,
            text: '負荷検証用の問題',
            image: null,
            revealImage: null,
            timeLimitSeconds: 60,
            points: 100,
            explanation: null,
            type: 'choice',
            choices: [
              { id: CHOICE_A, position: 1, text: 'あ', image: null, isCorrect: true },
              { id: CHOICE_B, position: 2, text: 'い', image: null, isCorrect: false },
            ],
          },
        ],
      },
      currentQuestionId: options.phase === 'lobby' ? null : QUESTION_ID,
      currentQuestionPosition: options.phase === 'lobby' ? null : 1,
      phaseStartedAt: now,
      answerDeadlineAt:
        options.deadlineInMs === null
          ? null
          : Timestamp.fromMillis(Date.now() + options.deadlineInMs),
      stateVersion: 1,
      joinOpen: true,
      // 500 人を受け入れられる上限にしておく（既定の 200 だと途中で ROOM_FULL になる）。
      maxParticipants: PARTICIPANTS + 100,
      participantCount: 0,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      ...(options.poll
        ? {
            mode: 'poll',
            pollSnapshot: {
              ballotId: 'ballot-load',
              title: '負荷検証の投票',
              structure: 'flat',
              groups: [],
              options: [
                { id: OPTION_A, position: 1, label: 'あ', groupId: null, note: null },
                { id: OPTION_B, position: 2, label: 'い', groupId: null, note: null },
              ],
              settings: {
                rankDepth: 1,
                points: [1],
                revealDepth: 3,
                resultFontSize: 160,
                backgroundAssetId: null,
              },
            },
            pollTally: null,
            revealedCount: 0,
            voteCount: 0,
          }
        : {}),
    });

    await room.collection('public').doc('state').set({
      roomId: ROOM_ID,
      phase: options.phase,
      stateVersion: 1,
      currentQuestionId: options.phase === 'lobby' ? null : QUESTION_ID,
      currentQuestionPosition: options.phase === 'lobby' ? null : 1,
      totalQuestions: 1,
      answerDeadlineAt: null,
      joinOpen: true,
      participantCount: 0,
      answeredCount: 0,
      updatedAt: now,
    });
  }

  /** 参加者を直接書き込む（登録経路を測らない場面の下ごしらえ）。 */
  async function seedMembers(count: number) {
    const { Timestamp } = await import('firebase-admin/firestore');
    const store = await db();
    const now = Timestamp.now();
    const members = store.collection('rooms').doc(ROOM_ID).collection('members');

    for (let index = 0; index < count; index += 400) {
      const batch = store.batch();
      for (let offset = 0; offset < 400 && index + offset < count; offset += 1) {
        const position = index + offset;
        const uid = `load-user-${position}`;
        batch.set(members.doc(uid), {
          id: uid,
          roomId: ROOM_ID,
          authUserId: uid,
          role: 'participant',
          nickname: `参加者${position}`,
          nicknameLower: `参加者${position}`,
          joinedAt: now,
          lastSeenAt: now,
          isActive: true,
          totalPoints: (position % 7) * 100,
          correctCount: position % 7,
          correctElapsedMsTotal: position * 13,
        });
      }
      await batch.commit();
    }
  }

  it(
    '開場直後に全員が同時に参加登録しても、1 人も落ちない',
    { timeout: 300_000 },
    async () => {
      await resetRoom({ phase: 'lobby', deadlineInMs: null });
      const { registerParticipant } = await import('@/infrastructure/firebase/transactions');

      const startedAt = performance.now();
      const results = await Promise.allSettled(
        Array.from({ length: PARTICIPANTS }, (_, index) =>
          registerParticipant(ROOM_ID, `load-user-${index}`, `参加者${index}`),
        ),
      );
      const elapsed = performance.now() - startedAt;
      const outcome = tally(results);

      const store = await db();
      const stored = await store
        .collection('rooms')
        .doc(ROOM_ID)
        .collection('members')
        .where('role', '==', 'participant')
        .count()
        .get();
      const roomDoc = await store.collection('rooms').doc(ROOM_ID).get();

      console.log(
        `[参加登録] ${outcome.ok}/${PARTICIPANTS} 成功 / ${ms(elapsed)} / ` +
          `1件あたり ${ms(elapsed / PARTICIPANTS)} / 失敗: ${describeFailures(outcome)}`,
      );
      console.log(
        `[参加登録] members 実数 ${stored.data().count} / ` +
          `rooms.participantCount ${roomDoc.data()?.participantCount}`,
      );

      // 会場では「入れなかった人」が出た時点で失敗。取りこぼしを許さない。
      expect(outcome.ok).toBe(PARTICIPANTS);
      expect(stored.data().count).toBe(PARTICIPANTS);
      // 表示に使う人数が実数と食い違わないこと。
      expect(roomDoc.data()?.participantCount).toBe(PARTICIPANTS);
    },
  );

  it(
    '「今から投票です」で全員が同時に押しても、1 票も落ちない',
    { timeout: 300_000 },
    async () => {
      /*
        投票は回答よりも同時性が高い。司会が「今から投票です」と言った直後に
        全員が押すため、1 台 1 票の書き込みが一気に並ぶ。

        ここで見ているのは「1 票も落ちないこと」。
        投票の経路をトランザクションにすると、参加登録で起きたのと同じ理由で
        ここが落ちる（上の registerParticipant の注記を参照）。

        なお**エミュレータは 1 ドキュメントあたりの書き込み制限を再現しません**。
        ここが通っても本番の混雑を確かめたことにはなりません。
        表示用の人数（rooms.voteCount）を票と別の書き込みにしているのは、
        本番の制限（1 ドキュメント毎秒 1 回程度）に対する備えです。
      */
      await resetRoom({ phase: 'poll_open', deadlineInMs: null, poll: true });
      await seedMembers(PARTICIPANTS);

      const { insertVote, bumpVoteCount } = await import(
        '@/infrastructure/firebase/repositories/poll-repository'
      );

      const startedAt = performance.now();
      const results = await Promise.allSettled(
        Array.from({ length: PARTICIPANTS }, (_, index) =>
          insertVote(ROOM_ID, `load-user-${index}`, [index % 2 === 0 ? OPTION_A : OPTION_B]).then(
            () => bumpVoteCount(ROOM_ID),
          ),
        ),
      );
      const elapsed = performance.now() - startedAt;
      const outcome = tally(results);

      const store = await db();
      const stored = await store.collection('rooms').doc(ROOM_ID).collection('votes').count().get();

      console.log(
        `[投票] ${outcome.ok}/${PARTICIPANTS} 成功 / ${ms(elapsed)} / ` +
          `1件あたり ${ms(elapsed / PARTICIPANTS)} / 失敗: ${describeFailures(outcome)}`,
      );

      // 会場では「入れられなかった人」が出た時点で失敗。
      expect(outcome.ok).toBe(PARTICIPANTS);
      expect(stored.data().count).toBe(PARTICIPANTS);
    },
  );

  it('二度押ししても 1 票しか入らない（同時に送っても）', { timeout: 300_000 }, async () => {
    await resetRoom({ phase: 'poll_open', deadlineInMs: null, poll: true });
    await seedMembers(2);

    const { insertVote } = await import('@/infrastructure/firebase/repositories/poll-repository');

    // 同じ端末から同時に 10 回。通ってよいのは 1 回だけ。
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => insertVote(ROOM_ID, 'load-user-0', [OPTION_A])),
    );
    const outcome = tally(results);

    const store = await db();
    const stored = await store.collection('rooms').doc(ROOM_ID).collection('votes').count().get();

    expect(outcome.ok).toBe(1);
    expect(stored.data().count).toBe(1);
    expect(outcome.failed.get('ALREADY_VOTED')).toBe(9);
  });

  it(
    '出題後に全員が同時に回答しても、1 件も落ちない',
    { timeout: 300_000 },
    async () => {
      await resetRoom({ phase: 'question_open', deadlineInMs: 120_000 });
      await seedMembers(PARTICIPANTS);

      const { submitAnswer, resetAnswerProgressThrottle } = await import(
        '@/infrastructure/firebase/transactions'
      );
      resetAnswerProgressThrottle();

      const startedAt = performance.now();
      const results = await Promise.allSettled(
        Array.from({ length: PARTICIPANTS }, (_, index) =>
          submitAnswer(ROOM_ID, `load-user-${index}`, {
            questionId: QUESTION_ID,
            choiceId: index % 2 === 0 ? CHOICE_A : CHOICE_B,
          }),
        ),
      );
      const elapsed = performance.now() - startedAt;
      const outcome = tally(results);

      const store = await db();
      const stored = await store
        .collection('rooms')
        .doc(ROOM_ID)
        .collection('answers')
        .where('questionId', '==', QUESTION_ID)
        .count()
        .get();

      console.log(
        `[回答登録] ${outcome.ok}/${PARTICIPANTS} 成功 / ${ms(elapsed)} / ` +
          `1件あたり ${ms(elapsed / PARTICIPANTS)} / 失敗: ${describeFailures(outcome)}`,
      );

      expect(outcome.ok).toBe(PARTICIPANTS);
      expect(stored.data().count).toBe(PARTICIPANTS);
    },
  );

  it(
    '同じ人が連打しても回答は 1 件だけになる',
    { timeout: 300_000 },
    async () => {
      await resetRoom({ phase: 'question_open', deadlineInMs: 120_000 });
      await seedMembers(SMALL);

      const { submitAnswer, resetAnswerProgressThrottle } = await import(
        '@/infrastructure/firebase/transactions'
      );
      resetAnswerProgressThrottle();

      // 1 人が 20 回同時に送る（電波の悪い会場での再送を模す）。
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          submitAnswer(ROOM_ID, 'load-user-0', { questionId: QUESTION_ID, choiceId: CHOICE_A }),
        ),
      );
      const outcome = tally(results);

      const store = await db();
      const stored = await store
        .collection('rooms')
        .doc(ROOM_ID)
        .collection('answers')
        .where('questionId', '==', QUESTION_ID)
        .count()
        .get();

      console.log(`[連打] 受理 ${outcome.ok} / 保存 ${stored.data().count} 件`);
      expect(stored.data().count).toBe(1);
    },
  );

  it(
    '正解発表でランキングを一斉に取っても、人数に比例して重くならない',
    { timeout: 300_000 },
    async () => {
      const { getRankedParticipants, resetRankingCache } = await import(
        '@/application/services/ranking-cache'
      );

      // 小規模と会場規模で「1 リクエストあたりの時間」を比べる。
      // 参加者ごとに全員ぶんを読み直していると、ここが人数に比例して伸びる。
      const measure = async (count: number): Promise<number> => {
        await resetRoom({ phase: 'answer_revealed', deadlineInMs: null });
        await seedMembers(count);
        resetRankingCache();
        // 一度読んで暖める（初回のインデックス構築を測らない）。
        // 覚え込みを検証したいわけではないので、計測直前に捨てる。
        await getRankedParticipants(ROOM_ID, 1);
        resetRankingCache();

        const startedAt = performance.now();
        await Promise.all(
          Array.from({ length: count }, () => getRankedParticipants(ROOM_ID, 1)),
        );
        return (performance.now() - startedAt) / count;
      };

      const small = await measure(SMALL);
      const large = await measure(PARTICIPANTS);

      const growth = large / small;
      console.log(
        `[ランキング] 1リクエストあたり ${SMALL}人=${ms(small)} → ` +
          `${PARTICIPANTS}人=${ms(large)}（${growth.toFixed(1)}倍）`,
      );

      // 人数が SMALL → PARTICIPANTS（20倍）になっても、
      // 1 リクエストあたりの時間が人数なりに増えてはいけない。
      // 増えるなら「参加者ごとに全員ぶん読んでいる」ということ。
      expect(growth).toBeLessThan(PARTICIPANTS / SMALL / 2);
    },
  );
});
