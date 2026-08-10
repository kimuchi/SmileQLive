import { expect, test } from '@playwright/test';

/**
 * ヘルスチェック（仕様書 §37.3 / Cloud Run の起動プローブ）。
 *
 * `/api/health` は外部 DB へ接続せず、Node.js プロセスが HTTP 応答できることだけを見る。
 * したがって **Firebase の設定が無い環境でも必ず通る**。
 * playwright.config.ts の webServer もこの URL の応答を待って起動判定している。
 */

type HealthBody = {
  status?: unknown;
  service?: unknown;
  timestamp?: unknown;
};

test.describe('ヘルスチェック', () => {
  test('/api/health が 200 で { status: "ok", service: "smileq-live" } を返す', async ({
    request,
  }) => {
    const response = await request.get('/api/health');

    expect(response.status()).toBe(200);

    const body: HealthBody = await response.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('smileq-live');
    // 応答時刻は ISO 8601 の文字列。値そのものは固定できないため型だけ確認する。
    expect(typeof body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(String(body.timestamp)))).toBe(false);
  });

  test('/api/health はキャッシュされない', async ({ request }) => {
    // 起動プローブが古い応答を掴むと、落ちているインスタンスを健全と誤判定する。
    const response = await request.get('/api/health');
    expect(response.headers()['cache-control']).toContain('no-store');
  });

  test('/api/health は秘密情報を含まない', async ({ request }) => {
    const response = await request.get('/api/health');
    const text = await response.text();

    // 応答に環境情報・鍵・トークンの類が混ざっていないこと。
    for (const forbidden of ['apiKey', 'token', 'secret', 'privateKey', 'FIREBASE_']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
