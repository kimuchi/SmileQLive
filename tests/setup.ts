import '@testing-library/jest-dom/vitest';

/**
 * Vitest の共通セットアップ。
 *
 * - `@testing-library/jest-dom` のカスタムマッチャを登録する。
 * - サーバー用モジュールが参照するダミー環境変数を用意する
 *   （テストは実際の Firebase へ接続しない。値の形式だけを満たす）。
 *
 * 注意:
 * 秘密情報は一切置かない。Firebase 版ではサーバー用の秘密情報が存在しない
 * （Cloud Run 実行サービスアカウントの ADC を使う。docs/FIRESTORE_MODEL.md §6）。
 */

/** 未設定のときだけ既定値を入れる（呼び出し側の上書きを妨げない）。 */
function setDefaultEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name].trim().length === 0) {
    process.env[name] = value;
  }
}

// Firebase（いずれも公開前提の識別子。秘密情報ではない）
setDefaultEnv('FIREBASE_PROJECT_ID', 'smileq-live-test');
setDefaultEnv('FIREBASE_API_KEY', 'test-api-key');
setDefaultEnv('FIREBASE_AUTH_DOMAIN', 'smileq-live-test.firebaseapp.com');
setDefaultEnv('FIREBASE_STORAGE_BUCKET', 'smileq-live-test.firebasestorage.app');
setDefaultEnv('FIREBASE_APP_ID', '1:000000000000:web:0000000000000000000000');

// アプリ設定
setDefaultEnv('APP_ENV', 'local');
setDefaultEnv('APP_BASE_URL', 'http://localhost:3000');
setDefaultEnv('MEDIA_BUCKET', 'smileq-live-test-media');
setDefaultEnv('PRESENTATION_LINK_TTL_MINUTES', '480');
setDefaultEnv('LOG_LEVEL', 'error');

// 参加トークンのバイト数。16 bytes → base64url 22 文字（テストの期待値を安定させる）。
setDefaultEnv('JOIN_TOKEN_BYTES', '16');

// ドメイン制限なし（テストでは profiles/{uid} の存在確認だけを前提にする）
setDefaultEnv('ALLOWED_AUTH_DOMAINS', '');
