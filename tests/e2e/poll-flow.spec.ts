import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type {
  CreateRoomResponse,
  HostSnapshotResponse,
  PollBallotDetailResponse,
  PollTallyResponse,
  RoomActionResponse,
} from '@/types/api';

/**
 * 投票モードの通しテスト。
 *
 * 司会・参加者 3 名・投影を同時に動かし、次を実際のブラウザと実際の Firestore で確かめる。
 *
 *   1. **1 台につき 1 票**。同じ端末から二度送っても増えない。
 *   2. **投票中に票の内訳が参加者・投影へ渡らない**。
 *      隠しているのではなく、そもそも応答に載っていないことまで見る。
 *   3. 締め切った時点で集計が凍り、司会が票数を直せる。
 *      直すのは票数だけで、点数と順位はサーバーが数え直す。
 *   4. **発表した順位までしか投影へ渡らない**。
 *      まだ出していない順位の名前が応答に載っていないことを見る。
 *   5. 発表は下の順位から。発表を始めたら受付へ戻せない。
 *
 * 実行に必要な環境変数は full-flow.spec.ts と同じ（docs/E2E.md 参照）。
 * 揃っていなければ理由つきでスキップする。
 */

const firebaseProject = process.env.E2E_FIREBASE_PROJECT ?? '';
const hostEmail = process.env.E2E_HOST_EMAIL ?? '';
const firebaseApiKey = process.env.E2E_FIREBASE_API_KEY ?? 'emulator-api-key';
const authEmulatorHost = process.env.E2E_AUTH_EMULATOR_HOST ?? '';
const hostIdTokenFromEnv = process.env.E2E_HOST_ID_TOKEN ?? '';

const REQUIRED_ENV: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'E2E_FIREBASE_PROJECT', value: firebaseProject },
  { name: 'E2E_HOST_EMAIL', value: hostEmail },
  {
    name: 'E2E_AUTH_EMULATOR_HOST または E2E_HOST_ID_TOKEN',
    value: authEmulatorHost || hostIdTokenFromEnv,
  },
];

const missingEnv = REQUIRED_ENV.filter((entry) => entry.value.length === 0).map(
  (entry) => entry.name,
);

// ---------------------------------------------------------------------------
// テストデータ
// ---------------------------------------------------------------------------

const BALLOT_TITLE = 'E2E 出し物コンテスト';
const OPTION_LABELS = ['営業部 ダンス', '開発部 コント', '総務部 合唱'] as const;

/** 発表するまで投影・参加者の応答に現れてはいけない文字列。 */
const FIRST_PLACE_LABEL = OPTION_LABELS[0];

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

async function signInHost(api: APIRequestContext): Promise<string> {
  if (hostIdTokenFromEnv) {
    return hostIdTokenFromEnv;
  }
  const base = `http://${authEmulatorHost}/identitytoolkit.googleapis.com/v1`;
  const fakeGoogleIdToken = JSON.stringify({
    sub: `e2e-host-${hostEmail}`,
    email: hostEmail,
    email_verified: true,
  });

  const response = await api.post(
    `${base}/accounts:signInWithIdp?key=${encodeURIComponent(firebaseApiKey)}`,
    {
      headers: { 'content-type': 'application/json' },
      data: {
        postBody: `id_token=${fakeGoogleIdToken}&providerId=google.com`,
        requestUri: 'http://localhost',
        returnIdpCredential: true,
        returnSecureToken: true,
      },
    },
  );
  expect(
    response.ok(),
    `Auth エミュレータで司会者を用意できませんでした: ${await response.text()}`,
  ).toBeTruthy();
  const body: { idToken?: unknown } = await response.json();
  return String(body.idToken);
}

async function okJson<T>(response: Awaited<ReturnType<APIRequestContext['post']>>): Promise<T> {
  if (!response.ok()) {
    throw new Error(`API が失敗しました: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function transition(
  api: APIRequestContext,
  roomId: string,
  action: string,
  expectedVersion: number,
): Promise<RoomActionResponse> {
  return okJson<RoomActionResponse>(
    await api.post(`/api/rooms/${roomId}/actions`, { data: { action, expectedVersion } }),
  );
}

/**
 * 画面が受け取った API 応答を見張り、まだ出していない中身が載っていないかを見る。
 *
 * 表示だけを見ると「受け取ったが隠している」場合を見逃す。
 * **ネットワークに載っていないこと**まで確かめるのが要点。
 */
function watchForLeaks(page: Page, secrets: readonly string[]) {
  const leaks: string[] = [];
  let watching = true;

  page.on('response', (response) => {
    if (!watching || !response.url().includes('/api/')) {
      return;
    }
    void response
      .text()
      .then((body) => {
        for (const secret of secrets) {
          if (body.includes(secret)) {
            leaks.push(`${response.url()} に「${secret}」が含まれていた`);
          }
        }
      })
      .catch(() => {
        // 本文を読めない応答は無視する。
      });
  });

  return { leaks, stop: () => (watching = false) };
}

async function joinAsParticipant(page: Page, joinUrl: string, nickname: string): Promise<void> {
  await page.goto(joinUrl);
  await page.getByLabel('ニックネーム').fill(nickname);
  await page.getByRole('button', { name: '参加する' }).click();
  await page.waitForURL(/\/play\//);
}

/** 投票して送る。押した順が順位になる。 */
async function vote(page: Page, labels: readonly string[]): Promise<void> {
  for (const label of labels) {
    await page.getByRole('button', { name: new RegExp(label) }).click();
  }
  await page.getByRole('button', { name: /投票する$/ }).click();
  await expect(page.getByText('投票を受け付けました')).toBeVisible();
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

test.describe('投票モードの通しテスト', () => {
  test.skip(
    missingEnv.length > 0,
    `Firebase を使う通しテストです。次の環境変数が未設定のためスキップします: ${missingEnv.join(', ')}（docs/E2E.md 参照）`,
  );

  test.slow();

  test('用紙から投票して、票を直してから下の順位から発表できる', async ({
    playwright,
    browser,
    baseURL,
  }) => {
    const origin = baseURL ?? 'http://127.0.0.1:3100';

    const hostApi = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { origin },
    });
    const authApi = await playwright.request.newContext();

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const contextC = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();

    // 受付中は「どれに何票入ったか」が参加者へ渡ってはいけない。
    const watcherA = watchForLeaks(pageA, ['"counts"', '"score"', 'pollTally']);

    try {
      await test.step('司会者がサインインする', async () => {
        const idToken = await signInHost(authApi);
        const session = await okJson<{ isHost: boolean }>(
          await hostApi.post('/api/auth/session', { data: { idToken } }),
        );
        expect(
          session.isHost,
          'profiles/{uid} が無いため司会者として扱われません（docs/E2E.md）',
        ).toBe(true);
      });

      // ---------------------------------------------------------------------
      // 投票用紙を作る
      // ---------------------------------------------------------------------
      let ballotId = '';
      let optionIds: string[] = [];

      await test.step('投票用紙を作り、選択肢と点数を入れる', async () => {
        const created = await okJson<PollBallotDetailResponse>(
          await hostApi.post('/api/admin/poll-ballots', {
            data: { title: BALLOT_TITLE, structure: 'flat' },
          }),
        );
        ballotId = created.ballot.id;

        optionIds = OPTION_LABELS.map(() => crypto.randomUUID());
        const updated = await okJson<PollBallotDetailResponse>(
          await hostApi.patch(`/api/admin/poll-ballots/${ballotId}`, {
            data: {
              options: OPTION_LABELS.map((label, index) => ({
                id: optionIds[index],
                label,
                note: null,
              })),
              // 3 位まで選び、5/3/1 点。発表は 3 位から。
              settings: { rankDepth: 3, points: [5, 3, 1], revealDepth: 3 },
            },
          }),
        );
        expect(updated.ballot.options.map((option) => option.label)).toEqual([...OPTION_LABELS]);
        expect(updated.ballot.settings.points).toEqual([5, 3, 1]);
      });

      // ---------------------------------------------------------------------
      // ルームを作って受付を開く
      // ---------------------------------------------------------------------
      let roomId = '';
      let joinUrl = '';
      let version = 0;

      await test.step('投票のルームを作る（参加 URL が返る）', async () => {
        const created = await okJson<CreateRoomResponse>(
          await hostApi.post('/api/rooms', { data: { mode: 'poll', ballotId } }),
        );
        roomId = created.roomId;
        expect(created.mode).toBe('poll');
        expect(created.joinUrl, '投票では参加 URL が要る').toBeTruthy();
        joinUrl = String(created.joinUrl);
      });

      await test.step('受付をはじめる', async () => {
        const result = await transition(hostApi, roomId, 'open_poll', version);
        version = result.stateVersion;
        expect(result.phase).toBe('poll_open');
      });

      // ---------------------------------------------------------------------
      // 参加者が投票する
      // ---------------------------------------------------------------------
      await test.step('3 名が参加して投票する', async () => {
        await joinAsParticipant(pageA, joinUrl, 'さくら');
        await joinAsParticipant(pageB, joinUrl, 'たろう');
        await joinAsParticipant(pageC, joinUrl, 'はなこ');

        // 1位 営業部 / 2位 開発部 / 3位 総務部
        await vote(pageA, [OPTION_LABELS[0], OPTION_LABELS[1], OPTION_LABELS[2]]);
        await vote(pageB, [OPTION_LABELS[0], OPTION_LABELS[2], OPTION_LABELS[1]]);
        await vote(pageC, [OPTION_LABELS[1], OPTION_LABELS[0], OPTION_LABELS[2]]);
      });

      await test.step('同じ端末からは二度投票できない', async () => {
        const anonApi = await playwright.request.newContext({
          baseURL: origin,
          extraHTTPHeaders: { origin },
          storageState: await contextA.storageState(),
        });
        const response = await anonApi.post(`/api/rooms/${roomId}/vote`, {
          data: { choices: [optionIds[2]] },
        });
        expect(response.status(), await response.text()).toBe(409);
        const body: { error?: { code?: string } } = await response.json();
        expect(body.error?.code).toBe('ALREADY_VOTED');
        await anonApi.dispose();
      });

      await test.step('受付中は票の内訳が参加者へ渡らない', async () => {
        await pageA.reload();
        await expect(pageA.getByText('投票を受け付けました')).toBeVisible();
        watcherA.stop();
        expect(watcherA.leaks, watcherA.leaks.join('\n')).toHaveLength(0);
      });

      // ---------------------------------------------------------------------
      // 締め切って集計を確かめる
      // ---------------------------------------------------------------------
      await test.step('締め切ると集計が凍る', async () => {
        const result = await transition(hostApi, roomId, 'close_poll', version);
        version = result.stateVersion;
        expect(result.phase).toBe('poll_closed');

        const snapshot = await okJson<HostSnapshotResponse>(
          await hostApi.get(`/api/rooms/${roomId}/host-snapshot`),
        );
        const rows = snapshot.snapshot.pollTally ?? [];
        // 営業部: 1位2票 + 2位1票 = 5*2 + 3*1 = 13 点
        const top = rows.find((row) => row.label === OPTION_LABELS[0]);
        expect(top?.counts).toEqual([2, 1, 0]);
        expect(top?.score).toBe(13);
        expect(top?.rank).toBe(1);
      });

      await test.step('司会が票数を直すと点数と順位が数え直される', async () => {
        // 紙の票で総務部へ 1 位を 10 票足す。
        const edited = await okJson<PollTallyResponse>(
          await hostApi.patch(`/api/rooms/${roomId}/poll-tally`, {
            data: {
              entries: [{ optionId: optionIds[2], counts: [10, 0, 2] }],
              voterCount: 13,
            },
          }),
        );
        const boosted = edited.rows.find((row) => row.label === OPTION_LABELS[2]);
        // 点数は受け取らない。票数から数え直す（10*5 + 0*3 + 2*1 = 52）。
        expect(boosted?.score).toBe(52);
        expect(boosted?.rank).toBe(1);
        expect(edited.voterCount).toBe(13);
      });

      await test.step('数え直すと投票の記録どおりに戻る', async () => {
        const recounted = await okJson<PollTallyResponse>(
          await hostApi.post(`/api/rooms/${roomId}/poll-tally`),
        );
        const restored = recounted.rows.find((row) => row.label === OPTION_LABELS[2]);
        expect(restored?.counts).toEqual([0, 1, 2]);
        expect(recounted.voterCount).toBe(3);
      });

      // ---------------------------------------------------------------------
      // 発表
      // ---------------------------------------------------------------------
      await test.step('発表を始めるとまだ何も出ていない', async () => {
        const result = await transition(hostApi, roomId, 'start_reveal', version);
        version = result.stateVersion;
        expect(result.phase).toBe('poll_revealing');

        const snapshot = await okJson<HostSnapshotResponse>(
          await hostApi.get(`/api/rooms/${roomId}/host-snapshot`),
        );
        expect(snapshot.snapshot.pollResult?.entries).toHaveLength(0);
      });

      await test.step('下の順位から 1 つずつ出る。出していない順位は届かない', async () => {
        const first = await transition(hostApi, roomId, 'reveal_next', version);
        version = first.stateVersion;

        const afterThird = await okJson<HostSnapshotResponse>(
          await hostApi.get(`/api/rooms/${roomId}/host-snapshot`),
        );
        expect(afterThird.snapshot.pollResult?.entries.map((entry) => entry.rank)).toEqual([3]);
        // 1 位の名前は結果のどこにも入っていない。
        expect(JSON.stringify(afterThird.snapshot.pollResult)).not.toContain(FIRST_PLACE_LABEL);

        const second = await transition(hostApi, roomId, 'reveal_next', version);
        version = second.stateVersion;
        const third = await transition(hostApi, roomId, 'reveal_next', version);
        version = third.stateVersion;

        const done = await okJson<HostSnapshotResponse>(
          await hostApi.get(`/api/rooms/${roomId}/host-snapshot`),
        );
        expect(done.snapshot.pollResult?.entries.map((entry) => entry.rank)).toEqual([3, 2, 1]);
        expect(done.snapshot.pollResult?.complete).toBe(true);
        expect(done.snapshot.pollResult?.entries.at(-1)?.label).toBe(FIRST_PLACE_LABEL);
      });

      await test.step('発表を始めたら受付へは戻せない', async () => {
        const response = await hostApi.post(`/api/rooms/${roomId}/actions`, {
          data: { action: 'reopen_poll', expectedVersion: version },
        });
        expect(response.ok(), '結果を見てから投票できてしまう').toBeFalsy();
      });

      await test.step('参加者にも発表済みの順位が届く', async () => {
        await pageA.reload();
        // 見出しで見る（画面の上には「結果発表中」の帯も出ている）。
        await expect(pageA.getByRole('heading', { name: '結果発表' })).toBeVisible();
        await expect(pageA.getByText(FIRST_PLACE_LABEL).first()).toBeVisible();
      });
    } finally {
      await contextA.close();
      await contextB.close();
      await contextC.close();
      await hostApi.dispose();
      await authApi.dispose();
    }
  });
});
