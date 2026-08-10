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

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * 16進文字列の定数時間比較。
 *
 * 注意: `Buffer.from(value, 'hex')` は 16 進として解釈できない文字を黙って捨て、
 * 不正な入力に対して空バッファを返す。そのままでは「不正な文字列同士」が
 * 空バッファ比較で一致してしまうため、先に形式を検証する。
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  // 奇数長は 1 バイトに満たない桁が生じるため受け付けない。
  if (a.length % 2 !== 0) {
    return false;
  }
  if (!HEX_PATTERN.test(a) || !HEX_PATTERN.test(b)) {
    return false;
  }

  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  if (bufferA.length !== bufferB.length) {
    return false;
  }

  try {
    return timingSafeEqual(bufferA, bufferB);
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
