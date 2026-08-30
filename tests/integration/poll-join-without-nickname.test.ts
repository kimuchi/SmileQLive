// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '@/lib/auth/session';

vi.mock('server-only', () => ({}));

/**
 * 投票のルームは、名前を聞かずに参加できること。
 *
 * 会場で 200 人にニックネームを打たせると、打ち終わるまでの数十秒が
 * まるごと待ち時間になる。投票では名前をどこにも出さない（順位表が無い）ので、
 * 二次元コードを読んだらそのまま投票させる。
 *
 * **画面任せにしない。** サーバー側で「投票なら名前を受け取らない」と決める。
 * 画面の分岐だけに頼ると、古い画面や作られたリクエストで
 * 名前付きの参加者が混ざり、投票の秘密が崩れる。
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

/** いま参加登録している端末の匿名利用者。テストごとに差し替える。 */
let currentUid = 'poll-join-uid-1';

function authUser(uid: string) {
  return { uid, id: uid, email: null, isAnonymous: true, displayName: null, hostedDomain: null };
}

vi.mock('@/lib/auth/anonymous', () => ({
  ensureAuthSession: async () => authUser(currentUid),
}));

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return { ...actual, getOptionalAuthUser: async () => authUser(currentUid) };
});

/** 参加登録の入り口は Request を見る（レート制限のキー）。中身は使わない。 */
function joinRequest(): Request {
  return new Request('https://quiz.example.com/api/join/x/register', { method: 'POST' });
}

describe.skipIf(!available)('投票のルームへの参加', () => {
  const suffix = String(Date.now());
  const pollToken = `poll-join-token-${suffix}`.padEnd(24, 'x').slice(0, 43);
  const quizToken = `quiz-join-token-${suffix}`.padEnd(24, 'x').slice(0, 43);

  beforeAll(async () => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'https://quiz.example.com';

    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { hashToken } = await import('@/lib/crypto/tokens');
    const { Timestamp } = await import('firebase-admin/firestore');
    const db = getDb();
    const now = Timestamp.now();

    const seed = async (roomId: string, mode: 'poll' | 'quiz', token: string) => {
      await db
        .collection('rooms')
        .doc(roomId)
        .set({
          id: roomId,
          ownerId: 'poll-join-owner',
          mode,
          quizId: null,
          joinTokenHash: hashToken(token),
          joinToken: token,
          joinTokenRotatedAt: now,
          phase: mode === 'poll' ? 'poll_open' : 'lobby',
          quizSnapshot: {
            quizId: '',
            title: mode === 'poll' ? '出し物コンテスト' : '社内クイズ',
            settings: {
              showLeaderboard: false,
              showTotalQuestions: false,
              showQuestionBeforeOpen: false,
              alwaysShowJoinCode: true,
              soundTheme: 'default',
              leaderboardSize: 0,
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
          joinOpen: true,
          maxParticipants: 200,
          participantCount: 0,
          createdAt: now,
          updatedAt: now,
          finishedAt: null,
        });
    };

    await seed(`poll-join-room-${suffix}`, 'poll', pollToken);
    await seed(`quiz-join-room-${suffix}`, 'quiz', quizToken);
  });

  it('名前を送らなくても参加できる', { timeout: 30_000 }, async () => {
    const { registerParticipant } = await import('@/application/services/join-service');

    currentUid = `poll-uid-a-${suffix}`;
    const registered = await registerParticipant(pollToken, {}, joinRequest());

    expect(registered.participantId).toBe(currentUid);
    // 表示名はサーバーが割り当てる（空にすると司会の名簿が読めなくなる）。
    expect(registered.nickname).toMatch(/^参加者[2-9A-HJ-NP-Z]{6}$/);
  });

  it('同じ端末で読み直しても増えない', { timeout: 30_000 }, async () => {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { registerParticipant } = await import('@/application/services/join-service');

    currentUid = `poll-uid-a-${suffix}`;
    const again = await registerParticipant(pollToken, {}, joinRequest());
    expect(again.participantId).toBe(currentUid);

    const members = await getDb()
      .collection('rooms')
      .doc(`poll-join-room-${suffix}`)
      .collection('members')
      .get();
    expect(members.size).toBe(1);
  });

  it('別の端末は別の参加者になり、表示名もぶつからない', { timeout: 30_000 }, async () => {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { registerParticipant } = await import('@/application/services/join-service');

    const people = 20;
    const registrations = [];
    for (let index = 0; index < people; index += 1) {
      currentUid = `poll-uid-b${String(index)}-${suffix}`;
      registrations.push(await registerParticipant(pollToken, {}, joinRequest()));
    }

    const nicknames = new Set(registrations.map((entry) => entry.nickname));
    expect(nicknames.size).toBe(people);

    const members = await getDb()
      .collection('rooms')
      .doc(`poll-join-room-${suffix}`)
      .collection('members')
      .get();
    expect(members.size).toBe(people + 1);
  });

  it('名前を送ってきても使わない', { timeout: 30_000 }, async () => {
    const { registerParticipant } = await import('@/application/services/join-service');

    currentUid = `poll-uid-c-${suffix}`;
    const registered = await registerParticipant(
      pollToken,
      { nickname: 'なまえを付けたい人' },
      joinRequest(),
    );

    // 誰が何に入れたかを名前で辿れるようにしない。
    expect(registered.nickname).not.toBe('なまえを付けたい人');
    expect(registered.nickname).toMatch(/^参加者[2-9A-HJ-NP-Z]{6}$/);
  });

  it('クイズのルームは、これまでどおり名前が要る', { timeout: 30_000 }, async () => {
    const { registerParticipant } = await import('@/application/services/join-service');
    const { AppError } = await import('@/lib/errors/app-error');

    currentUid = `quiz-uid-a-${suffix}`;
    await expect(registerParticipant(quizToken, {}, joinRequest())).rejects.toThrow(AppError);

    const registered = await registerParticipant(quizToken, { nickname: 'たろう' }, joinRequest());
    expect(registered.nickname).toBe('たろう');
  });

  it('参加 URL の解決がモードを返す', { timeout: 30_000 }, async () => {
    const { resolveJoinToken } = await import('@/application/services/join-service');

    expect((await resolveJoinToken(pollToken)).mode).toBe('poll');
    expect((await resolveJoinToken(quizToken)).mode).toBe('quiz');
  });
});
