import 'server-only';

import { parseAuthDomainList } from '@/lib/auth/shared';

/**
 * サーバー専用の環境変数アクセス。
 *
 * - Cloud Run では実行時に注入されるため、モジュール読み込み時点ではなく
 *   利用時に読む（ビルド時の値へ固定しない）。
 * - **Firebase 版ではサーバー用の秘密情報が存在しない。**
 *   Admin SDK は Cloud Run 実行サービスアカウントの ADC で認証するため、
 *   Supabase 版の `SUPABASE_SECRET_KEY` に相当する設定は不要（docs/FIRESTORE_MODEL.md §6）。
 * - `FIREBASE_API_KEY` は「公開前提の識別子」であり秘密情報ではない。
 *   実際の保護は Security Rules とサーバー側の認可で行う。
 */

export type AppEnvironment = 'local' | 'staging' | 'production';

function readEnv(name: string): string | null {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : null;
}

function required(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`MISSING_ENV: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return readEnv(name) ?? fallback;
}

// ---------------------------------------------------------------------------
// Firebase
// ---------------------------------------------------------------------------

/**
 * Firebase / GCP のプロジェクト ID。
 * Cloud Run では GOOGLE_CLOUD_PROJECT が自動注入されるため、それも受け付ける
 * （src/infrastructure/firebase/admin.ts と同じ解決順）。
 */
export function firebaseProjectId(): string {
  const value =
    readEnv('FIREBASE_PROJECT_ID') ?? readEnv('GOOGLE_CLOUD_PROJECT') ?? readEnv('GCLOUD_PROJECT');
  if (!value) {
    throw new Error('MISSING_ENV: FIREBASE_PROJECT_ID');
  }
  return value;
}

/** ブラウザの Firebase SDK 初期化に使う API キー。秘密情報ではない。 */
export function firebaseApiKey(): string {
  return required('FIREBASE_API_KEY');
}

/**
 * Firebase Auth のホストドメイン。
 * 未設定なら既定値 `<projectId>.firebaseapp.com` を使う
 * （カスタム認証ドメインを使う場合は必ず明示設定すること）。
 */
export function firebaseAuthDomain(): string {
  return readEnv('FIREBASE_AUTH_DOMAIN') ?? `${firebaseProjectId()}.firebaseapp.com`;
}

/** Cloud Storage の既定バケット。未設定なら Firebase の既定バケット名。 */
export function firebaseStorageBucket(): string {
  return readEnv('FIREBASE_STORAGE_BUCKET') ?? `${firebaseProjectId()}.firebasestorage.app`;
}

/** Firebase Web アプリの appId。Analytics を使わないため任意。 */
export function firebaseAppId(): string | null {
  return readEnv('FIREBASE_APP_ID');
}

/**
 * 管理・司会としてログインを許可するメールドメイン（カンマ区切り）。
 *
 * 例: `ALLOWED_AUTH_DOMAINS=example.co.jp,example.com`
 * **未設定ならドメイン制限を行わない。** その場合は profiles/{uid} を
 * 管理者が手動で用意する運用になる（自己登録は許可しない）。
 */
export function allowedAuthDomains(): string[] {
  return parseAuthDomainList(process.env.ALLOWED_AUTH_DOMAINS);
}

// ---------------------------------------------------------------------------
// アプリ設定
// ---------------------------------------------------------------------------

/** クイズ画像を置く Cloud Storage バケット。 */
export function mediaBucket(): string {
  return readEnv('MEDIA_BUCKET') ?? readEnv('QUIZ_MEDIA_BUCKET') ?? firebaseStorageBucket();
}

/** @deprecated 旧名。呼び出し側の移行が済むまで残す。`mediaBucket()` を使うこと。 */
export function quizMediaBucket(): string {
  return mediaBucket();
}

export function presentationLinkTtlMinutes(): number {
  const parsed = Number.parseInt(optional('PRESENTATION_LINK_TTL_MINUTES', '480'), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 480;
}

export function logLevel(): 'debug' | 'info' | 'warn' | 'error' {
  const value = optional('LOG_LEVEL', 'info');
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

export function appEnvironment(): AppEnvironment {
  const value = optional('APP_ENV', process.env.NODE_ENV === 'production' ? 'production' : 'local');
  return value === 'staging' || value === 'production' ? value : 'local';
}

export function turnstile(): { siteKey: string; secretKey: string } | null {
  const siteKey = readEnv('TURNSTILE_SITE_KEY');
  const secretKey = readEnv('TURNSTILE_SECRET_KEY');
  if (!siteKey || !secretKey) {
    return null;
  }
  return { siteKey, secretKey };
}

/**
 * 参加 URL・二次元コードの基準となる origin。
 *
 * 本番・ステージングでは APP_BASE_URL を正式ドメインへ固定する。
 * 未設定時のみ、信頼できるプロキシヘッダーから組み立てる。
 */
export function appBaseUrl(headers?: Headers): string {
  const configured = readEnv('APP_BASE_URL');
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  if (headers) {
    const forwardedHost = headers.get('x-forwarded-host') ?? headers.get('host');
    const forwardedProto = headers.get('x-forwarded-proto') ?? 'https';
    if (forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, '');
    }
  }

  return 'http://localhost:3000';
}

/**
 * 起動直後に構成不足を検出するための診断。管理画面へ明示的なエラーを出す用途。
 *
 * Firebase 版では**サーバー用の秘密情報を要求しない**。
 * ここで見るのはブラウザへ渡す公開設定だけ。
 */
export function checkServerConfiguration(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];

  if (
    !readEnv('FIREBASE_PROJECT_ID') &&
    !readEnv('GOOGLE_CLOUD_PROJECT') &&
    !readEnv('GCLOUD_PROJECT')
  ) {
    missing.push('FIREBASE_PROJECT_ID');
  }
  if (!readEnv('FIREBASE_API_KEY')) {
    missing.push('FIREBASE_API_KEY');
  }
  if (!readEnv('FIREBASE_AUTH_DOMAIN')) {
    missing.push('FIREBASE_AUTH_DOMAIN');
  }

  return { ok: missing.length === 0, missing };
}
