import { expect, test, type Page } from '@playwright/test';

/**
 * URL だけで回すルーレット（`/roulette`）。
 *
 * ここで守りたいのは 4 つ。
 *   1. **ログインが要らない。** 会議の司会決めのように、その場で開いて回すためのもの。
 *      ログイン画面へ飛ばされたらこの機能は成立しない。
 *   2. 配布されているルーレットと同じ形の URL をそのまま開ける。
 *   3. スタートで回り、ひとりでに止まって、止まった扇の名前が出る。
 *   4. 何も付けずに開いたら 1 から作れる。
 *
 * Firebase は要らない（サーバーへ何も送らないため）。
 * 効果音の一覧だけはサーバーへ取りに行くが、取れなくても画面は動く。
 */

/** 回り方の見本。減速を強めにして、テストが長く待たないようにする。 */
const BOARD = {
  name: ['山田 太郎', '田中 花子', '鈴木 一郎'],
  ratio: [1, 3, 2],
  show_characters_value: true,
  decel_value: 0.05,
};

function boardUrl(board: unknown = BOARD): string {
  return `/roulette?json=${encodeURIComponent(JSON.stringify(board))}`;
}

/** 止まるまで待つ。減速 0.05 なら 3 秒ほどで止まる。 */
async function waitUntilStopped(page: Page): Promise<void> {
  await expect(page.getByText('まわっています…')).toBeHidden({ timeout: 30_000 });
}

/** 扇に書かれている名前。SVG の文字は innerText で取れないので中身を直接読む。 */
async function segmentLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('svg text')].map((node) => node.textContent ?? ''),
  );
}

test.describe('URL だけで回すルーレット', () => {
  test('ログイン無しで開けて、URL の盤面がそのまま出る', async ({ page }) => {
    await page.goto(boardUrl());

    // ログイン画面へ飛ばされない。
    await expect(page).toHaveURL(/\/roulette\?/);
    await expect(page.getByRole('button', { name: 'スタート' })).toBeVisible();

    expect(await segmentLabels(page)).toEqual(['山田 太郎', '田中 花子', '鈴木 一郎']);
  });

  test('スタートで回り、ひとりでに止まって名前が出る', async ({ page }) => {
    await page.goto(boardUrl());

    await page.getByRole('button', { name: 'スタート' }).click();
    await expect(page.getByText('まわっています…')).toBeVisible();

    await waitUntilStopped(page);

    // 止まった扇の名前が出る。盤面に無い名前は出ない。
    const result = (await page.locator('[aria-live="polite"]').innerText()).trim();
    expect(BOARD.name).toContain(result);

    // 回っている間に結果を出していない（止まってから読む作りであること）。
    await expect(page.getByRole('button', { name: 'もう一度まわす' })).toBeVisible();
  });

  test('リセットで最初へ戻る', async ({ page }) => {
    await page.goto(boardUrl());

    await page.getByRole('button', { name: 'スタート' }).click();
    await waitUntilStopped(page);

    await page.getByRole('button', { name: 'リセット' }).click();

    await expect(page.getByText('スタートを押してください')).toBeVisible();
    await expect(page.getByRole('button', { name: 'スタート', exact: true })).toBeVisible();
  });

  test('何も付けずに開くと 1 から作れる', async ({ page }) => {
    await page.goto('/roulette');

    // 空の盤面では設定欄が開いた状態で始まる。
    await expect(page.getByText('この盤面を保存する')).toBeVisible();
    // 項目が 2 つ無いうちは回せない。
    await expect(page.getByRole('button', { name: 'スタート' })).toBeDisabled();

    await page.getByLabel('1番目の項目名').fill('あたり');
    await page.getByLabel('2番目の項目名').fill('はずれ');
    await page.getByLabel('2番目の重み').fill('4');

    await expect(page.getByRole('button', { name: 'スタート' })).toBeEnabled();
    expect(await segmentLabels(page)).toEqual(['あたり', 'はずれ']);
  });

  test('貼り付けで項目を入れられる', async ({ page }) => {
    await page.goto('/roulette');

    await page.getByRole('button', { name: '貼り付け・CSVで入れる' }).click();
    await page.getByLabel('貼り付け').fill('項目,重み\nA,1\nB,2\n,9');

    // 取り込む前に必ず下見が出る。飛ばした行も知らせる。
    await expect(page.getByText('2件を読み込みます')).toBeVisible();
    await expect(page.getByText(/項目名が空の行 1 件は飛ばしました/)).toBeVisible();

    await page.getByRole('button', { name: 'この内容で取り込む' }).click();

    expect(await segmentLabels(page)).toEqual(['A', 'B']);
    await expect(page.getByLabel('2番目の重み')).toHaveValue('2');
  });

  test('書き出した URL を開き直すと同じ盤面になる', async ({ page }) => {
    await page.goto(boardUrl());
    await page.getByRole('button', { name: '設定' }).click();

    const shareUrl = await page.getByLabel('この盤面のURL').inputValue();
    // 配布サイトと同じ形。あちらの URL もこちらの URL も同じ鍵で運ぶ。
    const json = new URL(shareUrl).searchParams.get('json') ?? '';
    expect(JSON.parse(json)).toEqual(BOARD);

    await page.goto(shareUrl);
    expect(await segmentLabels(page)).toEqual(BOARD.name);
  });

  test('URL が壊れていても白い画面にしない', async ({ page }) => {
    await page.goto('/roulette?json=%7Bbroken');

    await expect(page.getByText(/読み取れませんでした/)).toBeVisible();
    // その場で作り直せる。
    await expect(page.getByLabel('1番目の項目名')).toBeVisible();
  });
});

test.describe('効果音の設定', () => {
  test('ログイン無しで開ける', async ({ page }) => {
    await page.goto('/sounds');

    await expect(page).toHaveURL(/\/sounds$/);
    await expect(page.getByRole('heading', { name: '効果音' })).toBeVisible();
  });

  test('古い /admin/sounds は転送する', async ({ page }) => {
    await page.goto('/admin/sounds');

    // ログイン画面ではなく、ログイン不要の設定画面へ着く。
    await expect(page).toHaveURL(/\/sounds$/);
  });
});
