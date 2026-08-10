import 'server-only';

/**
 * サーバー専用の環境変数アクセス。
 *
 * - `SUPABASE_SECRET_KEY` を読むモジュールは必ず `server-only` を import する。
 * - Cloud Run では実行時に注入されるため、モジュール読み込み時点ではなく
 *   利用時に読む（ビルド時の値へ固定しない）。
 */

export type AppEnvironment = 'local' | 'staging' | 'production';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`MISSING_ENV: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : fallback;
}

export function supabaseUrl(): string {
  return required('SUPABASE_URL');
}

export function supabasePublishableKey(): string {
  return required('SUPABASE_PUBLISHABLE_KEY');
}

/** サーバー専用。ブラウザへ渡さない。 */
export function supabaseSecretKey(): string {
  return required('SUPABASE_SECRET_KEY');
}

export function quizMediaBucket(): string {
  return optional('QUIZ_MEDIA_BUCKET', 'quiz-media');
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
  const siteKey = process.env.TURNSTILE_SITE_KEY;
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
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
  const configured = process.env.APP_BASE_URL;
  if (configured && configured.trim().length > 0) {
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

/** 起動直後に構成不足を検出するための診断。管理画面へ明示的なエラーを出す用途。 */
export function checkServerConfiguration(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const name of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY']) {
    const value = process.env[name];
    if (!value || value.trim().length === 0) {
      missing.push(name);
    }
  }
  return { ok: missing.length === 0, missing };
}
