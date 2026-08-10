/**
 * Cloudflare Turnstile による参加登録時の人間確認。
 *
 * - TURNSTILE_SECRET_KEY が未設定なら CAPTCHA 機能そのものを無効とし、何も検証しない。
 * - 検証に失敗したときだけ AppError('CAPTCHA_FAILED') を投げる。
 * - 検証サービスへ到達できない場合は「通す」。会場での参加を止めないことを優先し、
 *   最終的な多重登録防止は DB の UNIQUE 制約とルーム定員で担保する。
 */

import { AppError } from '@/lib/errors/app-error';
import { logger } from '@/infrastructure/logging/logger';

const VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 4000;

/** Turnstile が構成済みか（サイトキー・シークレット両方が揃っているか）。 */
export function isCaptchaConfigured(): boolean {
  const siteKey = process.env.TURNSTILE_SITE_KEY;
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  return Boolean(siteKey && siteKey.trim() && secretKey && secretKey.trim());
}

type SiteVerifyResponse = {
  success: boolean;
  'error-codes'?: string[];
};

function parseSiteVerify(value: unknown): SiteVerifyResponse | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.success !== 'boolean') {
    return null;
  }
  const errorCodes = record['error-codes'];
  return {
    success: record.success,
    'error-codes': Array.isArray(errorCodes)
      ? errorCodes.filter((code): code is string => typeof code === 'string')
      : undefined,
  };
}

/**
 * トークンを検証する。未構成なら即座に戻る。
 * @param token クライアントから送られた Turnstile トークン
 * @param remoteIp クライアント IP（任意）。保存はしない。
 */
export async function verifyCaptchaIfConfigured(
  token: string | undefined,
  remoteIp: string | null,
): Promise<void> {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!isCaptchaConfigured() || !secretKey) {
    return;
  }

  if (!token || token.trim().length === 0) {
    throw new AppError('CAPTCHA_FAILED');
  }

  const body = new URLSearchParams();
  body.set('secret', secretKey);
  body.set('response', token);
  if (remoteIp) {
    body.set('remoteip', remoteIp);
  }

  let payload: unknown;
  try {
    const response = await fetch(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      // 検証サービス側の障害。参加を止めない。
      logger.warn('captcha.verify_unavailable', { status: response.status });
      return;
    }
    payload = await response.json();
  } catch (error) {
    logger.warn('captcha.verify_error', {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const parsed = parseSiteVerify(payload);
  if (!parsed) {
    logger.warn('captcha.verify_unexpected_payload');
    return;
  }

  if (!parsed.success) {
    logger.warn('captcha.verify_failed', { captchaErrorCodes: parsed['error-codes'] });
    throw new AppError('CAPTCHA_FAILED');
  }
}
