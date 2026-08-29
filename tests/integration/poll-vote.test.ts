// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '@/lib/auth/session';
import type { RoomDoc, RoomMemberDoc } from '@/types/firestore';

vi.mock('server-only', () => ({}));

/**
 * 投票モードの一連の流れ。会場でやり直しの効かない部分なので、
 * 実際のトランザクションをエミュレータ上で動かして確かめる。
 *
 * 確かめること:
 *   * **1 端末につき 1 票**。二度目は弾かれ、票数も増えない。
 *   * 受付中は**票数も順位も参加者へ渡らない**（途中経過で投票が引っぱられる）。
 *   * 締め切った時点で集計が**凍る**。そのあとの票は受け付けない。
 *   * 司会は票数を直せる。**点数は票数から計算し直される**。
 *   * 発表は**下の順位から 1 つずつ**。出していない順位は投影へ渡さない。
 *   * 発表を始めたら受付へは戻せない。
 *
 * 認証はテストのために差し替える。認可そのものは Security Rules 検証が見ている。
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

const OWNER_UID = 'poll-owner-uid';

/** いま誰として API を呼んでいるか。テストの中で切り替える。 */
let currentUid = OWNER_UID;

function userOf(uid: string) {
  return {
    uid,
    id: uid,
    email: uid === OWNER_UID ? 'host@example.com' : null,
    isAnonymous: uid !== OWNER_UID,
    displayName: null,
    hostedDomain: null,
  };
}

async function fetchRoomDoc(roomId: string): Promise<RoomDoc> {
  const { getDb } = await import('@/infrastructure/firebase/admin');
  const snapshot = await getDb().collection('rooms').doc(roomId).get();
  const room = snapshot.data() as RoomDoc | undefined;
  if (!room) {
    throw new Error(`ルームがありません: ${roomId}`);
  }
  return room;
}

async function fetchMember(roomId: string, uid: string): Promise<RoomMemberDoc> {
  const { getDb } = await import('@/infrastructure/firebase/admin');
  const snapshot = await getDb()
    .collection('rooms')
    .doc(roomId)
    .collection('members')
    .doc(uid)
    .get();
  const member = snapshot.data() as RoomMemberDoc | undefined;
  if (!member) {
    throw new Error(`参加者がいません: ${uid}`);
  }
  return member;
}

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    requireAuthUser: async () => userOf(currentUid),
    requireHostUser: async () => ({ user: userOf(OWNER_UID), profileId: OWNER_UID }),
    requireRoomOwner: async (roomId: string) => ({
      user: userOf(OWNER_UID),
      room: await fetchRoomDoc(roomId),
    }),
    requireRoomMember: async (roomId: string) => ({
      user: userOf(currentUid),
      member: await fetchMember(roomId, currentUid),
      room: await fetchRoomDoc(roomId),
    }),
    requireParticipant: async (roomId: string) => ({
      user: userOf(currentUid),
      member: await fetchMember(roomId, currentUid),
      room: await fetchRoomDoc(roomId),
    }),
  };
});

describe.skipIf(!available)('投票モードの進行', () => {
  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.MEDIA_BUCKET = 'smileq-live-emulator.appspot.com';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
    process.env.APP_BASE_URL = 'http://localhost';
  });

  /** 投票用紙を作る。1 位のみ・3 位まで発表、という一般的な形。 */
  async function seedBallot(options: { rankDepth?: number; points?: number[] } = {}) {
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const now = Timestamp.now();
    const ballotId = crypto.randomUUID();
    const optionIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

    await getDb()
      .collection('pollBallots')
      .doc(ballotId)
      .set({
        id: ballotId,
        ownerId: OWNER_UID,
        title: '出し物コンテスト',
        structure: 'flat',
        groups: [],
        options: optionIds.map((id, index) => ({
          id,
          position: index + 1,
          label: `出し物${index + 1}`,
          groupId: null,
          note: null,
        })),
        settings: {
          rankDepth: options.rankDepth ?? 1,
          points: options.points ?? [1],
          revealDepth: 3,
          resultFontSize: 160,
          backgroundAssetId: null,
        },
        optionCount: optionIds.length,
        createdAt: now,
        updatedAt: now,
      });

    return { ballotId, optionIds };
  }

  /** 参加者を登録する。 */
  async function join(roomId: string, uid: string, nickname: string) {
    const { registerParticipant } = await import('@/infrastructure/firebase/transactions');
    await registerParticipant(roomId, uid, nickname);
  }

  /** 司会として 1 手進める。 */
  async function act(roomId: string, action: string) {
    const previous = currentUid;
    currentUid = OWNER_UID;
    try {
      const { transitionRoom } = await import('@/application/services/room-service');
      const room = await fetchRoomDoc(roomId);
      return await transitionRoom(roomId, {
        action: action as never,
        expectedVersion: room.stateVersion,
      });
    } finally {
      currentUid = previous;
    }
  }

  /** 参加者として 1 票入れる。 */
  async function vote(roomId: string, uid: string, choices: string[]) {
    const previous = currentUid;
    currentUid = uid;
    try {
      const { submitVote } = await import('@/application/services/poll-service');
      return await submitVote(roomId, choices);
    } finally {
      currentUid = previous;
    }
  }

  /** 用紙から投票のルームを作り、受付を開いて参加者を入れる。 */
  async function openPollRoom(
    voters: string[],
    settings: { rankDepth?: number; points?: number[] } = {},
  ) {
    const { ballotId, optionIds } = await seedBallot(settings);
    const { createRoom } = await import('@/application/services/room-service');

    currentUid = OWNER_UID;
    const created = await createRoom({ mode: 'poll', ballotId });
    await act(created.roomId, 'open_poll');

    for (const [index, uid] of voters.entries()) {
      await join(created.roomId, uid, `参加者${index + 1}`);
    }

    return { roomId: created.roomId, created, optionIds };
  }

  it('用紙から投票のルームを作り、二次元コードで参加できる', { timeout: 60_000 }, async () => {
    const { ballotId } = await seedBallot();
    const { createRoom } = await import('@/application/services/room-service');

    currentUid = OWNER_UID;
    const created = await createRoom({ mode: 'poll', ballotId });

    expect(created.mode).toBe('poll');
    // 参加者がスマホから投票するので、参加 URL を返す。
    expect(created.joinUrl).toContain('/j/');
    expect(created.quizTitle).toBe('出し物コンテスト');

    const room = await fetchRoomDoc(created.roomId);
    expect(room.joinOpen).toBe(true);
    expect(room.pollSnapshot?.options).toHaveLength(3);
    expect(room.pollTally ?? null).toBeNull();
    expect(room.voteCount ?? 0).toBe(0);
    // 読み取り経路を増やさないため、問題 0 問のクイズを必ず入れる。
    expect((room.quizSnapshot as { questions: unknown[] }).questions).toEqual([]);
  });

  it('選択肢が 1 件も無い用紙ではルームを作らせない', { timeout: 60_000 }, async () => {
    // 当日「投票できません」と気づくことになる。
    const { getDb } = await import('@/infrastructure/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');
    const now = Timestamp.now();
    const ballotId = crypto.randomUUID();
    await getDb()
      .collection('pollBallots')
      .doc(ballotId)
      .set({
        id: ballotId,
        ownerId: OWNER_UID,
        title: '空の用紙',
        structure: 'flat',
        groups: [],
        options: [],
        settings: {
          rankDepth: 1,
          points: [1],
          revealDepth: 3,
          resultFontSize: 160,
          backgroundAssetId: null,
        },
        optionCount: 0,
        createdAt: now,
        updatedAt: now,
      });

    currentUid = OWNER_UID;
    const { createRoom } = await import('@/application/services/room-service');
    await expect(createRoom({ mode: 'poll', ballotId })).rejects.toMatchObject({
      code: 'POLL_BALLOT_EMPTY',
    });
  });

  it('1 端末につき 1 票しか入らない', { timeout: 60_000 }, async () => {
    const { roomId, optionIds } = await openPollRoom(['voter-a', 'voter-b']);

    await vote(roomId, 'voter-a', [optionIds[0]!]);
    // 同じ端末から二度目。通信のやり直しでも、押し直しでも同じ扱い。
    await expect(vote(roomId, 'voter-a', [optionIds[1]!])).rejects.toMatchObject({
      code: 'ALREADY_VOTED',
    });

    await vote(roomId, 'voter-b', [optionIds[1]!]);

    const room = await fetchRoomDoc(roomId);
    // 弾かれた票で人数が増えていないこと。
    expect(room.voteCount).toBe(2);
  });

  it('用紙に無い選択肢と、順位より多い票は受け付けない', { timeout: 60_000 }, async () => {
    const { roomId, optionIds } = await openPollRoom(['voter-x', 'voter-y']);

    await expect(vote(roomId, 'voter-x', [crypto.randomUUID()])).rejects.toMatchObject({
      code: 'POLL_CHOICE_INVALID',
    });
    // 1 位だけ選ぶ会に 2 件送られても、どちらを 1 位にするか決められない。
    await expect(vote(roomId, 'voter-y', [optionIds[0]!, optionIds[1]!])).rejects.toMatchObject({
      code: 'POLL_CHOICE_INVALID',
    });

    // 弾かれた票は 1 件も残らない。
    const room = await fetchRoomDoc(roomId);
    expect(room.voteCount ?? 0).toBe(0);
  });

  it('受付中の参加者には票数も順位も渡さない', { timeout: 60_000 }, async () => {
    const { roomId, optionIds } = await openPollRoom(['voter-1', 'voter-2']);
    await vote(roomId, 'voter-1', [optionIds[0]!]);
    await vote(roomId, 'voter-2', [optionIds[0]!]);

    currentUid = 'voter-1';
    const { getParticipantSnapshot } = await import('@/application/services/room-service');
    const snapshot = await getParticipantSnapshot(roomId);

    expect(snapshot.poll?.options).toHaveLength(3);
    // 自分が入れたものは自分にだけ返す。
    expect(snapshot.myVote).toEqual([optionIds[0]]);
    // どこにも票数・順位が入っていない（画面で隠すのではなく、そもそも送らない）。
    expect(snapshot.pollResult).toBeNull();
    const text = JSON.stringify(snapshot.poll);
    expect(text).not.toContain('counts');
    expect(text).not.toContain('score');
  });

  it('締め切った時点で集計が凍り、そのあとの票は受け付けない', { timeout: 60_000 }, async () => {
    const { roomId, optionIds } = await openPollRoom(['v1', 'v2', 'v3', 'late']);
    await vote(roomId, 'v1', [optionIds[0]!]);
    await vote(roomId, 'v2', [optionIds[0]!]);
    await vote(roomId, 'v3', [optionIds[1]!]);

    await act(roomId, 'close_poll');

    const room = await fetchRoomDoc(roomId);
    expect(room.phase).toBe('poll_closed');
    expect(room.pollTally?.voterCount).toBe(3);
    expect(
      room.pollTally?.entries.find((entry) => entry.optionId === optionIds[0])?.counts,
    ).toEqual([2]);

    // 締め切ったあとの票を数えると、凍らせた集計と実際の票がずれる。
    await expect(vote(roomId, 'late', [optionIds[2]!])).rejects.toMatchObject({
      code: 'POLL_NOT_OPEN',
    });
  });

  it('司会は締切後に票数を直せて、点数は数え直される', { timeout: 60_000 }, async () => {
    // 3 位まで選び、点数 5/3/1 の会。
    const { roomId, optionIds } = await openPollRoom(['p1', 'p2'], {
      rankDepth: 3,
      points: [5, 3, 1],
    });
    await vote(roomId, 'p1', [optionIds[0]!, optionIds[1]!, optionIds[2]!]);
    await vote(roomId, 'p2', [optionIds[1]!, optionIds[0]!, optionIds[2]!]);
    await act(roomId, 'close_poll');

    currentUid = OWNER_UID;
    const { editPollTally } = await import('@/application/services/poll-service');

    // 紙の投票を 10 票ぶん足す。
    await editPollTally(roomId, [{ optionId: optionIds[2]!, counts: [10, 0, 0] }], 12);

    const { getStaffSnapshot } = await import('@/application/services/room-service');
    const snapshot = await getStaffSnapshot(roomId, 'host');
    const rows = snapshot.pollTally ?? [];

    // 直したのは票数だけ。点数はそこから計算し直される（10 × 5 点）。
    const edited = rows.find((row) => row.optionId === optionIds[2]);
    expect(edited?.counts).toEqual([10, 0, 0]);
    expect(edited?.score).toBe(50);
    expect(edited?.rank).toBe(1);

    // 直していない選択肢はそのまま残る。
    const untouched = rows.find((row) => row.optionId === optionIds[0]);
    expect(untouched?.counts).toEqual([1, 1, 0]);
    expect(untouched?.score).toBe(8);
  });

  it('直しすぎたら投票の記録から数え直せる', { timeout: 60_000 }, async () => {
    const { roomId, optionIds } = await openPollRoom(['r1', 'r2']);
    await vote(roomId, 'r1', [optionIds[0]!]);
    await vote(roomId, 'r2', [optionIds[0]!]);
    await act(roomId, 'close_poll');

    currentUid = OWNER_UID;
    const { editPollTally, recountPollTally } = await import('@/application/services/poll-service');

    await editPollTally(roomId, [{ optionId: optionIds[0]!, counts: [999] }]);
    const recounted = await recountPollTally(roomId);

    // 投票の記録そのものは消していないので、いつでも戻せる。
    expect(recounted.entries.find((entry) => entry.optionId === optionIds[0])?.counts).toEqual([2]);
    expect(recounted.voterCount).toBe(2);
  });

  it(
    '発表は下の順位から 1 つずつ、出していない順位は投影へ渡さない',
    { timeout: 60_000 },
    async () => {
      const { roomId, optionIds } = await openPollRoom(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
      // 3票 / 2票 / 1票 → 1位=0番, 2位=1番, 3位=2番。
      await vote(roomId, 'a1', [optionIds[0]!]);
      await vote(roomId, 'a2', [optionIds[0]!]);
      await vote(roomId, 'a3', [optionIds[0]!]);
      await vote(roomId, 'a4', [optionIds[1]!]);
      await vote(roomId, 'a5', [optionIds[1]!]);
      await vote(roomId, 'a6', [optionIds[2]!]);

      await act(roomId, 'close_poll');
      await act(roomId, 'start_reveal');

      const { getStaffSnapshot } = await import('@/application/services/room-service');
      currentUid = OWNER_UID;

      // 発表を始めた直後はまだ何も出さない。
      let presenter = await getStaffSnapshot(roomId, 'presenter');
      expect(presenter.pollResult?.entries).toEqual([]);
      // 投影担当には全順位の表を渡さない（会場のスクリーンに映りうる）。
      expect(presenter.pollTally).toBeUndefined();

      await act(roomId, 'reveal_next');
      presenter = await getStaffSnapshot(roomId, 'presenter');
      expect(presenter.pollResult?.entries.map((entry) => entry.rank)).toEqual([3]);
      // 1 位の名前はまだどこにも入っていない。
      expect(JSON.stringify(presenter.pollResult)).not.toContain('出し物1');

      await act(roomId, 'reveal_next');
      presenter = await getStaffSnapshot(roomId, 'presenter');
      expect(presenter.pollResult?.entries.map((entry) => entry.rank)).toEqual([3, 2]);

      await act(roomId, 'reveal_next');
      presenter = await getStaffSnapshot(roomId, 'presenter');
      expect(presenter.pollResult?.entries.map((entry) => entry.rank)).toEqual([3, 2, 1]);
      expect(presenter.pollResult?.complete).toBe(true);
      expect(presenter.pollResult?.entries.at(-1)?.label).toBe('出し物1');

      // 出しきったあとに押しても進まない。
      await expect(act(roomId, 'reveal_next')).rejects.toMatchObject({ code: 'POLL_REVEAL_DONE' });
    },
  );

  it('締切の押し間違いからは戻せるが、発表を始めたら戻せない', { timeout: 60_000 }, async () => {
    const { roomId, optionIds } = await openPollRoom(['b1']);
    await vote(roomId, 'b1', [optionIds[0]!]);
    await act(roomId, 'close_poll');

    // 締切直後なら受付へ戻せる。凍らせた集計は捨てる。
    await act(roomId, 'reopen_poll');
    let room = await fetchRoomDoc(roomId);
    expect(room.phase).toBe('poll_open');
    expect(room.pollTally).toBeNull();
    // 票そのものは残っているので、続きから受け付けられる。
    expect(room.voteCount).toBe(1);

    await act(roomId, 'close_poll');
    await act(roomId, 'start_reveal');

    // 結果を見てから投票できてしまうので、ここからは戻せない。
    await expect(act(roomId, 'reopen_poll')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });

    room = await fetchRoomDoc(roomId);
    expect(room.phase).toBe('poll_revealing');
  });

  it('表示用の人数が書けなくても投票は成立する', { timeout: 60_000 }, async () => {
    /*
      会場の全員が同時に押すと `rooms/{id}` が混み合う。
      そこで票の書き込みと人数の加算を分けてある。
      人数の側が落ちても、票は入っていなければならない。
    */
    const { roomId, optionIds } = await openPollRoom(['d1']);
    const repository = await import('@/infrastructure/firebase/repositories/poll-repository');

    currentUid = 'd1';
    await repository.insertVote(roomId, 'd1', [optionIds[0]!]);

    // 票は入っているが、表示用の人数はまだ 0 のまま。
    expect((await fetchRoomDoc(roomId)).voteCount ?? 0).toBe(0);
    expect(await repository.findVote(roomId, 'd1')).not.toBeNull();

    // 締め切ると実際の票を数え直して上書きするので、ずれは残らない。
    await act(roomId, 'close_poll');
    const room = await fetchRoomDoc(roomId);
    expect(room.voteCount).toBe(1);
    expect(room.pollTally?.voterCount).toBe(1);
  });

  it('練習の票を捨てて本番を始められる', { timeout: 60_000 }, async () => {
    const { roomId, optionIds } = await openPollRoom(['c1', 'c2']);
    await vote(roomId, 'c1', [optionIds[0]!]);
    await vote(roomId, 'c2', [optionIds[1]!]);

    currentUid = OWNER_UID;
    const { clearPollVotes } = await import('@/application/services/poll-service');
    const cleared = await clearPollVotes(roomId);

    expect(cleared).toBe(2);
    const room = await fetchRoomDoc(roomId);
    // 票だけ消えて人数が残ると、受付を開き直しても終わったように見える。
    expect(room.voteCount).toBe(0);

    // 捨てたあとは同じ端末からもう一度入れられる。
    await vote(roomId, 'c1', [optionIds[2]!]);
    expect((await fetchRoomDoc(roomId)).voteCount).toBe(1);
  });
});
