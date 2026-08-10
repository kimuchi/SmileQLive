import { expect, test, type Page } from '@playwright/test';

/**
 * 参加導線は二次元コードの参加 URL 直行だけ（仕様書 §37.3）。
 *
 * 検証したいこと:
 *   1. **ルームコード（参加コード）を手入力する欄がどこにも存在しない。**
 *      会場で「コードを読み上げて入力してもらう」運用へ逆戻りしないための回帰防止。
 *   2. 無効な参加 URL では「この参加URLは無効」系の案内が出る。
 *      無効なときに入力欄が現れて手入力を促す、という退行が起きないこと。
 *
 * この spec は **Firebase を必要としない**。
 * 参加 URL の解決はサーバー API が行うため、Firebase 未構成の環境でも
 * 判定が変わらないように、応答を実物と同じ本文で差し替える検証を併せて置く。
 */

/** 形式は正しいが実在しない参加トークン（20〜64 文字の [A-Za-z0-9_-]）。 */
const INVALID_JOIN_PATH = '/j/aaaaaaaaaaaaaaaaaaaaaa';

/** ルームコード入力欄と疑われる文言。 */
const ROOM_CODE_TEXT = /ルームコード|ルーム番号|参加コード|部屋コード|room\s*code|game\s*pin/i;

/** 入力欄の属性に現れうる名前。 */
const ROOM_CODE_ATTRIBUTE = /(room|game|join|entry).*(code|pin)|(code|pin).*(room|game)/i;

/**
 * 「ルームコードを手入力させる UI が無い」ことを確かめる。
 *
 * 文言・入力欄の属性・入力欄の有無の 3 方向から見る。
 * 将来 UI を書き換えても、どれか 1 つが引っかかれば気づける。
 */
async function expectNoRoomCodeInput(page: Page): Promise<void> {
  // 1. それらしい文言が画面に無い。
  await expect(page.getByText(ROOM_CODE_TEXT)).toHaveCount(0);

  // 2. 入力欄の name / id / placeholder / aria-label にコード入力を思わせるものが無い。
  const inputs = page.locator('input, textarea');
  const count = await inputs.count();
  for (let index = 0; index < count; index += 1) {
    const field = inputs.nth(index);
    const attributes = await Promise.all([
      field.getAttribute('name'),
      field.getAttribute('id'),
      field.getAttribute('placeholder'),
      field.getAttribute('aria-label'),
      field.getAttribute('inputmode'),
    ]);
    const joined = attributes.filter((value): value is string => value !== null).join(' ');
    expect(joined).not.toMatch(ROOM_CODE_ATTRIBUTE);
    expect(joined).not.toMatch(ROOM_CODE_TEXT);
  }
}

test.describe('ルームコード手入力の導線が存在しない', () => {
  test('無効な参加URLでは「この参加URLは無効」と出て、ルームコード入力欄が現れない', async ({
    page,
  }) => {
    // 参加 URL の解決はサーバー API（Firestore を引く）。
    // Firebase の有無で結果が変わらないよう、実際の 404 応答と同じ本文を返す。
    await page.route('**/api/join/*/resolve', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'JOIN_LINK_INVALID',
            message: 'この参加URLは無効です',
            requestId: 'e2e-no-room-code',
          },
        }),
      });
    });

    await page.goto(INVALID_JOIN_PATH);

    await expect(page.getByText('参加できませんでした')).toBeVisible();
    await expect(page.getByText(/この参加URLは無効/)).toBeVisible();

    // 入力欄そのものが 1 つも無い（ニックネーム欄すら出ない）。
    await expect(page.locator('input, textarea')).toHaveCount(0);
    await expectNoRoomCodeInput(page);
  });

  test('参加 URL の応答を差し替えなくても、ルームコード入力欄は現れない', async ({ page }) => {
    // 応答を差し替えない素の状態。Firebase 未構成なら読み込み失敗の案内、
    // 構成済みなら無効リンクの案内になる。**どちらでも入力欄は出てはいけない。**
    await page.goto(INVALID_JOIN_PATH);

    await expect(
      page.getByText(/参加できませんでした|読み込めませんでした|この参加URLは無効/),
    ).toBeVisible();

    await expectNoRoomCodeInput(page);
  });

  test('参加トークンが参加 URL のパス以外へ現れない', async ({ page }) => {
    await page.route('**/api/join/*/resolve', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'JOIN_LINK_INVALID', message: 'この参加URLは無効です', requestId: 'e2e' },
        }),
      });
    });

    await page.goto(INVALID_JOIN_PATH);

    // タイトル・本文へトークンを複製しない（読み上げ・スクリーンショットからの漏洩を防ぐ）。
    await expect(page).toHaveTitle(/クイズに参加/);
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain('aaaaaaaaaaaaaaaaaaaaaa');
  });

  test('コード入力用のページが存在しない', async ({ page }) => {
    // 「/join でコードを入力して参加」という導線を後から足していないことの確認。
    for (const path of ['/join', '/enter', '/code']) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} は存在してはいけない`).toBe(404);
      await expect(page.locator('input, textarea')).toHaveCount(0);
    }
  });
});
