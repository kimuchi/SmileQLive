import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type {
  BreakdownResponse,
  CreateRoomResponse,
  HostSnapshotResponse,
  LeaderboardResponse,
  PresentationLinkResponse,
  PublishResponse,
  QuestionResponse,
  QuizDetailResponse,
  RoomActionResponse,
} from '@/types/api';

/**
 * 仕様書 §37.3 — 会場進行の通しテスト（1〜22）。
 *
 * 司会・参加者2名・投影担当を同時に動かし、
 * **正解を正解発表前に参加者へ渡さない**という最重要要件が
 * 実際のブラウザと実際の Firestore の組み合わせで守られていることを確かめる。
 *
 * ---------------------------------------------------------------------------
 * 実行に必要な環境変数（docs/E2E.md 参照）
 * ---------------------------------------------------------------------------
 *   E2E_FIREBASE_PROJECT   … Firebase / Firestore のプロジェクト ID（エミュレータ可）
 *   E2E_HOST_EMAIL         … 司会者アカウントのメールアドレス
 *   次のどちらか一方:
 *     E2E_AUTH_EMULATOR_HOST … 例 127.0.0.1:9099。Auth エミュレータ上で
 *                              「Google でサインインした司会者」を作ってから進める
 *     E2E_HOST_ID_TOKEN      … 実プロジェクト向け。手元で取得した Google の ID トークン
 *                              （実 Google の OAuth 画面は自動化できないため）
 *   E2E_FIREBASE_API_KEY   … 任意。省略時はエミュレータ用のダミー
 *
 * 揃っていなければ **理由つきでスキップ**する。
 * このファイルを削除・コメントアウトしないこと。Firebase を用意した環境では
 * ここが唯一の「通しで動くことの証明」になる。
 *
 * 補足: サーバーは Google と匿名以外のサインイン方法を受け付けない
 * （src/app/api/auth/session/route.ts）。したがってメール＋パスワードでは司会者になれない。
 * Auth エミュレータでは signInWithIdp に偽の ID トークンを渡すことで
 * 「google.com プロバイダ・メール確認済み」の利用者を作れる。ここではそれを使う。
 */

// ---------------------------------------------------------------------------
// 実行条件
// ---------------------------------------------------------------------------

const firebaseProject = process.env.E2E_FIREBASE_PROJECT ?? '';
const hostEmail = process.env.E2E_HOST_EMAIL ?? '';
const firebaseApiKey = process.env.E2E_FIREBASE_API_KEY ?? 'emulator-api-key';
const authEmulatorHost = process.env.E2E_AUTH_EMULATOR_HOST ?? '';
const hostIdTokenFromEnv = process.env.E2E_HOST_ID_TOKEN ?? '';

/** この通しテストに必須の環境変数。 */
const REQUIRED_ENV: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'E2E_FIREBASE_PROJECT', value: firebaseProject },
  { name: 'E2E_HOST_EMAIL', value: hostEmail },
  // どちらか一方あればよい（司会者のサインイン手段）。
  {
    name: 'E2E_AUTH_EMULATOR_HOST または E2E_HOST_ID_TOKEN',
    value: authEmulatorHost || hostIdTokenFromEnv,
  },
];

/** 足りない環境変数の一覧。空なら実行できる。 */
const missingEnv = REQUIRED_ENV.filter((entry) => entry.value.length === 0).map(
  (entry) => entry.name,
);

// ---------------------------------------------------------------------------
// テストデータ
// ---------------------------------------------------------------------------

const QUIZ_TITLE = 'E2E 通しテスト';
const CHOICE_QUESTION_TEXT = '日本でいちばん高い山は？';
const CORRECT_CHOICE_TEXT = '富士山';
const WRONG_CHOICE_TEXT = '北岳';
const CHOICE_EXPLANATION = '富士山の標高は3776m です。';
const NUMBER_QUESTION_TEXT = 'この会場から駅までの距離は？';
/** range 判定の**下端ちょうど**。両端を含むことの確認になる。 */
const NUMBER_BOUNDARY_ANSWER = '9.5';

/** 正解発表前に参加者側へ現れてはいけない文字列。 */
const SECRETS_BEFORE_REVEAL = [
  CORRECT_CHOICE_TEXT,
  CHOICE_EXPLANATION,
  '"isCorrect"',
  'numberCorrectValue',
  'quizSnapshot',
];

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/**
 * 司会者としてサインインし、ID トークンを得る。
 *
 * Auth エミュレータでは `accounts:signInWithIdp` に偽の Google ID トークンを渡す。
 * これで `sign_in_provider = google.com` / `email_verified = true` の利用者になり、
 * サーバー側（/api/auth/session）の受け入れ条件を満たす。
 *
 * 実プロジェクトでは Google の同意画面を自動化できないため、
 * 事前に取得した ID トークンを E2E_HOST_ID_TOKEN で渡してもらう。
 */
async function signInHost(api: APIRequestContext): Promise<string> {
  if (hostIdTokenFromEnv) {
    return hostIdTokenFromEnv;
  }

  const base = `http://${authEmulatorHost}/identitytoolkit.googleapis.com/v1`;
  // エミュレータは postBody の id_token を JSON としてそのまま信用する。
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
  expect(typeof body.idToken, 'ID トークンを取得できませんでした').toBe('string');
  return String(body.idToken);
}

/** 応答が 2xx であることを確かめつつ JSON を取り出す。 */
async function okJson<T>(response: Awaited<ReturnType<APIRequestContext['post']>>): Promise<T> {
  if (!response.ok()) {
    throw new Error(`API が失敗しました: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** 司会の進行操作。stateVersion は必ずサーバーの返り値で更新する。 */
async function transition(
  api: APIRequestContext,
  roomId: string,
  action: string,
  expectedVersion: number,
  questionId?: string,
): Promise<RoomActionResponse> {
  const response = await api.post(`/api/rooms/${roomId}/actions`, {
    data: { action, expectedVersion, ...(questionId ? { questionId } : {}) },
  });
  return okJson<RoomActionResponse>(response);
}

/**
 * 参加者ページが受け取った応答本文を監視し、
 * 正解に類する文字列が流れてこないことを見張る。
 *
 * 画面表示だけを見ると「受け取ったが隠している」場合を見逃す。
 * **ネットワークに載っていないこと**まで確かめるのが要点。
 */
function watchForLeakedAnswers(page: Page): { leaks: string[]; stop: () => void } {
  const leaks: string[] = [];
  let watching = true;

  page.on('response', (response) => {
    if (!watching) {
      return;
    }
    const url = response.url();
    // HTML / JS のバンドルは対象外（アプリのコード自体に文字列は含まれない前提だが、
    // 画像やチャンクまで読むと誤検知になるため API 応答だけを見る）。
    if (!url.includes('/api/')) {
      return;
    }
    void response
      .text()
      .then((body) => {
        for (const secret of SECRETS_BEFORE_REVEAL) {
          if (body.includes(secret)) {
            leaks.push(`${url} に「${secret}」が含まれていた`);
          }
        }
      })
      .catch(() => {
        // 本文を読めない応答（リダイレクト・中断）は無視する。
      });
  });

  return {
    leaks,
    stop: () => {
      watching = false;
    },
  };
}

/** 参加 URL を開いてニックネームを登録し、進行画面へ入る。 */
async function joinAsParticipant(page: Page, joinUrl: string, nickname: string): Promise<void> {
  await page.goto(joinUrl);
  await page.getByLabel('ニックネーム').fill(nickname);
  await page.getByRole('button', { name: '参加する' }).click();
  await page.waitForURL(/\/play\//);
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

test.describe('§37.3 会場進行の通しテスト', () => {
  test.skip(
    missingEnv.length > 0,
    `Firebase を使う通しテストです。次の環境変数が未設定のためスキップします: ${missingEnv.join(', ')}（docs/E2E.md 参照）`,
  );

  // 22 手順ぶんの操作をするため既定より長めに取る。
  test.slow();

  test('1〜22: 司会・参加者2名・投影の通し進行で正解が発表前に漏れない', async ({
    playwright,
    browser,
    baseURL,
  }) => {
    const origin = baseURL ?? 'http://127.0.0.1:3100';

    // 司会用の API コンテキスト（セッションクッキーはここへ溜まる）。
    const hostApi = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { origin },
    });
    // Firebase Auth 用（アプリのオリジンとは別）。
    const authApi = await playwright.request.newContext();

    const participantA = await browser.newContext();
    const participantB = await browser.newContext();
    const presenterContext = await browser.newContext();

    const pageA = await participantA.newPage();
    const pageB = await participantB.newPage();
    const presenterPage = await presenterContext.newPage();

    const watcherA = watchForLeakedAnswers(pageA);
    const watcherB = watchForLeakedAnswers(pageB);

    try {
      // ---------------------------------------------------------------------
      // 1. 司会者がサインインする
      // ---------------------------------------------------------------------
      await test.step('1. 司会者がサインインしてセッションクッキーを得る', async () => {
        const idToken = await signInHost(authApi);
        const response = await hostApi.post('/api/auth/session', { data: { idToken } });
        const session = await okJson<{ uid: string; isHost: boolean; isAnonymous: boolean }>(
          response,
        );
        expect(session.isAnonymous, '司会者が匿名セッションになっている').toBe(false);
        expect(
          session.isHost,
          `profiles/${session.uid} が無いため司会者として扱われません。` +
            ' scripts/host-admin.mjs（npm run host:add）で登録してください。詳しくは docs/E2E.md。',
        ).toBe(true);
      });

      // ---------------------------------------------------------------------
      // 2〜5. クイズを作って公開する
      // ---------------------------------------------------------------------
      let quizId = '';
      let choiceQuestionId = '';
      let numberQuestionId = '';

      await test.step('2. クイズを作成する', async () => {
        const created = await okJson<QuizDetailResponse>(
          await hostApi.post('/api/admin/quizzes', { data: { title: QUIZ_TITLE } }),
        );
        quizId = created.quiz.id;
        expect(created.quiz.status).toBe('draft');
      });

      await test.step('3. 選択式の問題を追加する', async () => {
        const created = await okJson<QuestionResponse>(
          await hostApi.post(`/api/admin/quizzes/${quizId}/questions`, {
            data: {
              type: 'choice',
              text: CHOICE_QUESTION_TEXT,
              explanation: CHOICE_EXPLANATION,
              timeLimitSeconds: 30,
              points: 1000,
              choices: [
                { position: 1, text: WRONG_CHOICE_TEXT, isCorrect: false },
                { position: 2, text: CORRECT_CHOICE_TEXT, isCorrect: true },
              ],
            },
          }),
        );
        choiceQuestionId = created.question.id;
        expect(created.question.choices).toHaveLength(2);
      });

      await test.step('4. 数値式の問題（範囲判定）を追加する', async () => {
        const created = await okJson<QuestionResponse>(
          await hostApi.post(`/api/admin/quizzes/${quizId}/questions`, {
            data: {
              type: 'number',
              text: NUMBER_QUESTION_TEXT,
              timeLimitSeconds: 30,
              points: 500,
              numberRule: { mode: 'range', minValue: '9.5', maxValue: '10.5' },
              unit: 'km',
              decimalPlaces: 1,
            },
          }),
        );
        numberQuestionId = created.question.id;
        // 数値は必ず文字列で往復する（Firestore の number 型へ入れない）。
        expect(created.question.numberMinValue).toBe('9.5');
        expect(created.question.numberMaxValue).toBe('10.5');
      });

      await test.step('5. クイズを公開する', async () => {
        const published = await okJson<PublishResponse>(
          await hostApi.post(`/api/admin/quizzes/${quizId}/publish`),
        );
        expect(published.issues, JSON.stringify(published.issues)).toHaveLength(0);
        expect(published.published).toBe(true);
      });

      // ---------------------------------------------------------------------
      // 6〜8. ルームと投影
      // ---------------------------------------------------------------------
      let roomId = '';
      let joinUrl = '';
      let stateVersion = 0;

      await test.step('6. ルームを作成し、参加URL（二次元コードの中身）を受け取る', async () => {
        const room = await okJson<CreateRoomResponse>(
          await hostApi.post('/api/rooms', { data: { quizId } }),
        );
        roomId = room.roomId;
        // クイズのルームなので参加 URL は必ず返る。
        expect(room.joinUrl).not.toBeNull();
        joinUrl = room.joinUrl ?? '';
        expect(room.quizTitle).toBe(QUIZ_TITLE);
        // 参加URLはトークンをパスに持つ（クエリ文字列へ載せない）。
        expect(joinUrl).toContain('/j/');
        expect(joinUrl).not.toContain('?');
      });

      await test.step('7. 投影用リンクを発行する', async () => {
        const link = await okJson<PresentationLinkResponse>(
          await hostApi.post(`/api/rooms/${roomId}/presentation-link`),
        );
        expect(link.presentationUrl).toContain('/present/token/');
        await presenterPage.goto(link.presentationUrl);
      });

      await test.step('8. 投影画面が引き換えを終えてルーム画面になる', async () => {
        // トークンは引き換え後に URL から消える（replace 遷移）。
        await presenterPage.waitForURL(new RegExp(`/present/${roomId}$`));
        expect(presenterPage.url()).not.toContain('/present/token/');
      });

      // ---------------------------------------------------------------------
      // 9〜12. 参加
      // ---------------------------------------------------------------------
      await test.step('9. 参加者Aが参加URLからニックネームを登録して参加する', async () => {
        await joinAsParticipant(pageA, joinUrl, 'さくら');
        expect(pageA.url(), '参加後の URL に参加トークンが残っている').not.toContain('/j/');
      });

      await test.step('10. 参加者Bが参加する', async () => {
        await joinAsParticipant(pageB, joinUrl, 'たろう');
      });

      await test.step('11. 司会 Snapshot に参加者が 2 人見える', async () => {
        const snapshot = await okJson<HostSnapshotResponse>(
          await hostApi.get(`/api/rooms/${roomId}/host-snapshot`),
        );
        expect(snapshot.snapshot.participantCount).toBe(2);
        stateVersion = snapshot.snapshot.stateVersion;
      });

      await test.step('12. 参加受付を締め切る', async () => {
        const response = await hostApi.post(`/api/rooms/${roomId}/close-join`);
        expect(response.ok()).toBeTruthy();
      });

      // ---------------------------------------------------------------------
      // 13〜14. 出題（★ 正解はまだ渡さない）
      // ---------------------------------------------------------------------
      await test.step('13. 第1問を表示する（question_ready）', async () => {
        const result = await transition(
          hostApi,
          roomId,
          'show_question',
          stateVersion,
          choiceQuestionId,
        );
        expect(result.phase).toBe('question_ready');
        stateVersion = result.stateVersion;
      });

      await test.step('14. ★ 正解発表前の参加者へ正解・解説が届いていない', async () => {
        await expect(pageA.getByText(CHOICE_QUESTION_TEXT)).toBeVisible();
        await expect(pageA.getByRole('button', { name: CORRECT_CHOICE_TEXT })).toBeVisible();

        // 画面には「正解」を示す装飾が無い。
        await expect(pageA.getByText('正解！')).toHaveCount(0);
        await expect(pageA.getByText(CHOICE_EXPLANATION)).toHaveCount(0);

        // ネットワークにも載っていない（解説・isCorrect・quizSnapshot）。
        expect(
          watcherA.leaks.filter((leak) => !leak.includes(CORRECT_CHOICE_TEXT)),
          `参加者Aへ正解情報が流れた: ${watcherA.leaks.join(' / ')}`,
        ).toEqual([]);
      });

      // ---------------------------------------------------------------------
      // 15〜19. 回答
      // ---------------------------------------------------------------------
      await test.step('15. 回答受付を開始する（question_open）', async () => {
        const result = await transition(hostApi, roomId, 'open_question', stateVersion);
        expect(result.phase).toBe('question_open');
        stateVersion = result.stateVersion;
      });

      await test.step('16. 参加者Aが正解の選択肢を選ぶ', async () => {
        await pageA.getByRole('button', { name: CORRECT_CHOICE_TEXT }).click();
        await expect(pageA.getByText('あなたの回答')).toBeVisible();
        // 受理されただけで、正誤はまだ出さない。
        await expect(pageA.getByText('正解！')).toHaveCount(0);
      });

      await test.step('17. 参加者Bが不正解の選択肢を選ぶ', async () => {
        await pageB.getByRole('button', { name: WRONG_CHOICE_TEXT }).click();
        await expect(pageB.getByText('あなたの回答')).toBeVisible();
        await expect(pageB.getByText('残念…')).toHaveCount(0);
      });

      await test.step('18. 同じ参加者は 2 回目の回答を登録できない', async () => {
        // 決定的ドキュメントID + create() による 1参加者1問1回答の担保。
        const response = await pageA.request.post(`${origin}/api/rooms/${roomId}/answer`, {
          headers: { origin },
          data: { questionId: choiceQuestionId, choiceId: 'ignored-by-server' },
        });
        expect(response.status(), '二重回答が受理されてしまった').toBeGreaterThanOrEqual(400);
      });

      await test.step('19. 回答を締め切る（締切後の回答は拒否される）', async () => {
        const result = await transition(hostApi, roomId, 'lock_question', stateVersion);
        expect(result.phase).toBe('question_locked');
        stateVersion = result.stateVersion;

        // 締切判定はサーバー時刻。クライアントが何を送っても通らない。
        const late = await pageB.request.post(`${origin}/api/rooms/${roomId}/answer`, {
          headers: { origin },
          data: { questionId: choiceQuestionId, choiceId: 'late' },
        });
        expect(late.status()).toBeGreaterThanOrEqual(400);
      });

      // ---------------------------------------------------------------------
      // 20〜21. 正解発表と集計
      // ---------------------------------------------------------------------
      await test.step('20. 正解を発表する（ここで初めて正解が参加者へ届く）', async () => {
        const result = await transition(hostApi, roomId, 'reveal_answer', stateVersion);
        expect(result.phase).toBe('answer_revealed');
        stateVersion = result.stateVersion;

        // ここから先は正解が届いてよいので、漏洩監視を止める。
        watcherA.stop();
        watcherB.stop();

        await expect(pageA.getByText('正解！')).toBeVisible();
        await expect(pageB.getByText('残念…')).toBeVisible();
        await expect(pageA.getByText(CHOICE_EXPLANATION)).toBeVisible();
      });

      await test.step('21. 内訳とランキングを表示する', async () => {
        const breakdown = await okJson<BreakdownResponse>(
          await hostApi.get(`/api/rooms/${roomId}/breakdown`),
        );
        expect(breakdown.breakdown, '締切後なのに内訳が出ない').not.toBeNull();

        const result = await transition(hostApi, roomId, 'show_scoreboard', stateVersion);
        expect(result.phase).toBe('scoreboard');
        stateVersion = result.stateVersion;

        const leaderboard = await okJson<LeaderboardResponse>(
          await hostApi.get(`/api/rooms/${roomId}/leaderboard`),
        );
        expect(leaderboard.leaderboard.length).toBeGreaterThan(0);
        // 正解した参加者Aが先頭。
        expect(leaderboard.leaderboard.at(0)?.nickname).toBe('さくら');
      });

      // ---------------------------------------------------------------------
      // 22. 第2問（数値・境界値）と終了
      // ---------------------------------------------------------------------
      await test.step('22. 第2問（数値・境界値）を出題し、クイズを終了する', async () => {
        let result = await transition(
          hostApi,
          roomId,
          'show_question',
          stateVersion,
          numberQuestionId,
        );
        stateVersion = result.stateVersion;

        result = await transition(hostApi, roomId, 'open_question', stateVersion);
        stateVersion = result.stateVersion;

        // range の下端ちょうど。両端を含むため正解になる。
        await expect(pageA.getByText(NUMBER_QUESTION_TEXT)).toBeVisible();
        await pageA.getByLabel('数値回答').fill(NUMBER_BOUNDARY_ANSWER);
        await pageA.getByRole('button', { name: '回答する' }).click();
        await expect(pageA.getByText('あなたの回答')).toBeVisible();

        result = await transition(hostApi, roomId, 'lock_question', stateVersion);
        stateVersion = result.stateVersion;
        result = await transition(hostApi, roomId, 'reveal_answer', stateVersion);
        stateVersion = result.stateVersion;

        await expect(pageA.getByText('正解！')).toBeVisible();

        result = await transition(hostApi, roomId, 'finish_room', stateVersion);
        expect(result.phase).toBe('finished');
      });
    } finally {
      await pageA.close();
      await pageB.close();
      await presenterPage.close();
      await participantA.close();
      await participantB.close();
      await presenterContext.close();
      await hostApi.dispose();
      await authApi.dispose();
    }
  });
});
