import { expect, test, type Page } from '@playwright/test';

/**
 * URL だけで回すルーレット（`/roulette`）。
 *
 * ここで守りたいのは 6 つ。
 *   1. **ログインが要らない。** 会議の司会決めのように、その場で開いて回すためのもの。
 *      ログイン画面へ飛ばされたらこの機能は成立しない。
 *   2. 配布されているルーレットと同じ形の URL をそのまま開ける。
 *   3. **スタートで回り続け、ストップで止まる。** 勝手に止まらない
 *      （司会が「そろそろ止めます」の間を作れなくなる）。
 *   4. 速さと止まるまでの時間を**別々に**決められる。
 *   5. 効果音の案内やテストのボタンを出さない。押さなくても鳴る。
 *   6. 何も付けずに開いたら 1 から作れる。背景画像も設定できる。
 *
 * Firebase は要らない（サーバーへ何も送らないため）。
 * 効果音の一覧だけはサーバーへ取りに行くが、取れなくても画面は動く。
 */

/** 回り方の見本。止まるまでを短くして、テストが長く待たないようにする。 */
const BOARD = {
  name: ['山田 太郎', '田中 花子', '鈴木 一郎'],
  ratio: [1, 3, 2],
  show_characters_value: true,
  decel_value: 0.4,
  speed_value: 720,
  stop_seconds: 1,
};

function boardUrl(board: unknown = BOARD): string {
  return `/roulette?json=${encodeURIComponent(JSON.stringify(board))}`;
}

/** スタート → ストップ → 止まるまで。 */
async function spinAndStop(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'スタート' }).click();
  await expect(page.getByText('まわっています…')).toBeVisible();

  // ストップを押すまで止まらない。押してから決めた秒数で止まる。
  await page.getByRole('button', { name: 'ストップ' }).click();
  await expect(page.getByText('とまります…')).toBeHidden({ timeout: 30_000 });
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

  test('スタートで回り続け、ストップで止まって名前が出る', async ({ page }) => {
    await page.goto(boardUrl());

    await page.getByRole('button', { name: 'スタート' }).click();
    await expect(page.getByText('まわっています…')).toBeVisible();

    // **押すまで止まらない。** ここが自動で止まると、司会が間を作れない。
    await page.waitForTimeout(2500);
    await expect(page.getByText('まわっています…')).toBeVisible();

    await page.getByRole('button', { name: 'ストップ' }).click();
    await expect(page.getByText('とまります…')).toBeHidden({ timeout: 30_000 });

    // 止まった扇の名前が出る。盤面に無い名前は出ない。
    const result = (await page.locator('[aria-live="polite"]').innerText()).trim();
    expect(BOARD.name).toContain(result);

    await expect(page.getByRole('button', { name: 'もう一度まわす' })).toBeVisible();
  });

  test('回していないときはストップを押せない', async ({ page }) => {
    await page.goto(boardUrl());

    await expect(page.getByRole('button', { name: 'ストップ' })).toBeDisabled();

    await page.getByRole('button', { name: 'スタート' }).click();
    await expect(page.getByRole('button', { name: 'ストップ' })).toBeEnabled();
    // 回している間はスタートを押し直せない。
    await expect(page.getByRole('button', { name: 'スタート' })).toBeDisabled();

    await page.getByRole('button', { name: 'ストップ' }).click();
    await expect(page.getByText('とまります…')).toBeHidden({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'ストップ' })).toBeDisabled();
  });

  test('リセットで最初へ戻る', async ({ page }) => {
    await page.goto(boardUrl());

    await spinAndStop(page);
    await page.getByRole('button', { name: 'リセット' }).click();

    await expect(page.getByText('スタートを押してください')).toBeVisible();
    await expect(page.getByRole('button', { name: 'スタート', exact: true })).toBeVisible();
  });

  /**
   * 会場で「効果音を有効にする」を探させない。
   * 音はブラウザの決まりで最初の操作まで鳴らせないが、スタートを押した
   * その 1 押しで解除が済むので、案内の帯もテストのボタンも出さない。
   */
  test('効果音の案内やテストのボタンを出さない', async ({ page }) => {
    await page.goto(boardUrl());

    await expect(page.getByText('効果音はまだ鳴りません')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /効果音を有効にする/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /音を鳴らして確認/ })).toHaveCount(0);

    // 案内が無くても、ボタンは押せて回る。
    await page.getByRole('button', { name: 'スタート' }).click();
    await expect(page.getByText('まわっています…')).toBeVisible();
  });

  test('速さと止まるまでの時間を別々に決められる', async ({ page }) => {
    await page.goto(boardUrl());
    await page.getByRole('button', { name: '設定' }).click();

    await page.getByLabel('回る速さ').fill('1080');
    await expect(page.getByText(/1 秒に/)).toContainText('3.0');
    // 速さを変えても止まるまでの時間はそのまま。
    await expect(page.getByText(/秒かけて止まります/)).toContainText('1');

    await page.getByLabel('止まるまでの時間').fill('4');
    await expect(page.getByText(/秒かけて止まります/)).toContainText('4');
    await expect(page.getByText(/1 秒に/)).toContainText('3.0');

    // 書き出す URL にも両方入る。
    const shareUrl = await page.getByLabel('この盤面のURL').inputValue();
    const json = JSON.parse(new URL(shareUrl).searchParams.get('json') ?? '{}') as {
      speed_value: number;
      stop_seconds: number;
    };
    expect(json.speed_value).toBe(1080);
    expect(json.stop_seconds).toBe(4);
  });

  test('背景画像を設定できる', async ({ page }) => {
    // 実際に画像を取りに行かせない（外部へ出ない）。
    await page.route('**/bg.png', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        // 1x1 の透明 PNG。
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
          'base64',
        ),
      }),
    );

    await page.goto(boardUrl());
    await page.getByRole('button', { name: '設定' }).click();

    await page.getByLabel('画像の URL').fill('https://example.com/bg.png');
    await page.getByRole('button', { name: 'この URL を使う' }).click();

    // 盤面の裏に敷かれる（設定欄の下見とは別物なので、飾りの側だけを見る）。
    const backdrop = page.locator('img[aria-hidden="true"][src="https://example.com/bg.png"]');
    await expect(backdrop).toBeVisible();

    // URL にも載って、開き直すと背景が戻る。
    const shareUrl = await page.getByLabel('この盤面のURL').inputValue();
    await page.goto(shareUrl);
    await expect(backdrop).toBeVisible();
  });

  /**
   * 投影は横長。**盤面は画面の高さいっぱいに出し、結果とボタンはその右**。
   * 上下に積むと、会場から見て盤面が小さくなってしまう。
   */
  test('横長では盤面が画面の高さいっぱいに出て、操作は右に並ぶ', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(boardUrl());
    await page.waitForSelector('text=スタート');

    const box = await page.evaluate(() => {
      const svg = document.querySelector('svg[aria-label^="ルーレット"]');
      const wheel = svg?.getBoundingClientRect();
      const start = [...document.querySelectorAll('button')]
        .find((node) => node.textContent?.includes('スタート'))
        ?.getBoundingClientRect();
      return wheel && start
        ? {
            wheel: { w: wheel.width, h: wheel.height, right: wheel.right },
            startLeft: start.left,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            scrollH: document.documentElement.scrollHeight,
          }
        : null;
    });

    expect(box).not.toBeNull();
    if (!box) {
      return;
    }

    // 正方形のまま、画面の高さのほとんどを使う。
    expect(Math.abs(box.wheel.w - box.wheel.h)).toBeLessThan(2);
    expect(box.wheel.h).toBeGreaterThan(box.viewport.h * 0.9);

    // 操作は盤面の右。下に積んでいない。
    expect(box.startLeft).toBeGreaterThanOrEqual(box.wheel.right);

    // 縦にはみ出して、盤面の下が切れていない。
    expect(box.scrollH).toBeLessThanOrEqual(box.viewport.h + 1);
  });

  test('縦長では盤面の下に操作が並ぶ', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto(boardUrl());
    await page.waitForSelector('text=スタート');

    const box = await page.evaluate(() => {
      const wheel = document
        .querySelector('svg[aria-label^="ルーレット"]')
        ?.getBoundingClientRect();
      const start = [...document.querySelectorAll('button')]
        .find((node) => node.textContent?.includes('スタート'))
        ?.getBoundingClientRect();
      return wheel && start ? { wheelBottom: wheel.bottom, startTop: start.top } : null;
    });

    expect(box).not.toBeNull();
    expect(box?.startTop).toBeGreaterThanOrEqual(box?.wheelBottom ?? 0);
  });

  test('背景に暗い膜を重ねない', async ({ page }) => {
    await page.route('**/bg.png', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
          'base64',
        ),
      }),
    );

    await page.goto(boardUrl({ ...BOARD, background_url: 'https://example.com/bg.png' }));
    await page.waitForSelector('text=スタート');

    // 背景画像の上に、全面を覆う半透明の板を置いていない。
    const veils = await page.evaluate(() => {
      const img = document.querySelector('img[aria-hidden="true"]');
      const parent = img?.parentElement;
      if (!parent) {
        return -1;
      }
      return [...parent.children].filter((node) => {
        if (node === img) {
          return false;
        }
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.position === 'absolute' &&
          rect.width >= window.innerWidth * 0.9 &&
          style.backgroundColor !== 'rgba(0, 0, 0, 0)'
        );
      }).length;
    });
    expect(veils).toBe(0);
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
    expect(JSON.parse(json)).toMatchObject({
      name: BOARD.name,
      ratio: BOARD.ratio,
      show_characters_value: true,
      speed_value: BOARD.speed_value,
      stop_seconds: BOARD.stop_seconds,
    });

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
