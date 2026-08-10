import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';

/**
 * ブラウザを自前で用意している環境向けの実行ファイル指定。
 *
 * Playwright は自身のバージョンに紐づくブラウザを要求するため、
 * イメージへ焼き込まれたブラウザとバージョンがずれると起動できない。
 * その場合に `PLAYWRIGHT_CHROMIUM_PATH` で実体を指定できるようにしておく
 * （リポジトリへ環境固有のパスを書かないため、既定は未設定）。
 */
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        // 既にブラウザが用意されている環境（CI イメージ・サンドボックス等）では
        // PLAYWRIGHT_CHROMIUM_PATH で実行ファイルを指定できる。
        // 未設定なら Playwright が自前で取得したブラウザを使う。
        ...(chromiumExecutablePath ? { launchOptions: { executablePath: chromiumExecutablePath } } : {}),
      },
    },
    {
      name: 'mobile-safari',
      use: {
        ...devices['iPhone 14'],
        // WebKit が無い環境では Chromium で代替できるようにしておく
        // （タップ領域・数値キーボードの検証はエンジン差の影響が小さいため）。
        ...(chromiumExecutablePath
          ? { browserName: 'chromium' as const, launchOptions: { executablePath: chromiumExecutablePath } }
          : {}),
      },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node scripts/e2e-server.mjs',
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
