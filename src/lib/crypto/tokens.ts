import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 参加トークン・投影トークンの生成とハッシュ化。
 *
 * - 生成はサーバー側のみ。
 * - DB へは SHA-256 ハッシュだけを保存し、平文を復元できる設計にしない。
 * - 平文はルーム作成／再発行のレスポンスで 1 回だけ返す。
 */

export const JOIN_TOKEN_MIN_BYTES = 16;
export const PRESENTATION_TOKEN_BYTES = 32;

/** base64url なので長さは 4/3 倍。16 bytes → 22 文字。 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

export type IssuedToken = { token: string; tokenHash: string };

function tokenBytesFromEnv(): number {
  const raw = process.env.JOIN_TOKEN_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < JOIN_TOKEN_MIN_BYTES) {
    return JOIN_TOKEN_MIN_BYTES;
  }
  return parsed;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createJoinToken(): IssuedToken {
  const token = randomBytes(tokenBytesFromEnv()).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function createPresentationToken(): IssuedToken {
  const token = randomBytes(PRESENTATION_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** URL から受け取った文字列が、トークンとして妥当な形式かを先に検査する。 */
export function isPlausibleToken(value: string): boolean {
  return BASE64URL_PATTERN.test(value);
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** ログ・エラートラッキングへ出す前にトークンを潰す。 */
export function redactToken(_token: string): string {
  return '[redacted]';
}

/** `/j/xxxx` を `/j/[redacted]` へ変換する。 */
export function redactPath(pathname: string): string {
  return pathname
    .replace(/^\/j\/[^/]+/, '/j/[redacted]')
    .replace(/^\/api\/join\/[^/]+/, '/api/join/[redacted]')
    .replace(/^\/present\/token\/[^/]+/, '/present/token/[redacted]');
}
