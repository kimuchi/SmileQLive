/**
 * インスタンスローカルのベストエフォート・レート制限。
 *
 * **重要な制約**
 * Cloud Run は複数インスタンスへ水平スケールするため、このカウンタは厳密ではない。
 * インスタンスが N 台あれば実効上限は最大 N 倍になりうる。
 * ここでの制限は「1 インスタンスへ集中する連打を安く弾く」ための緩衝材であり、
 * 一意性・重複防止といった**最終的な整合性は必ず DB の UNIQUE 制約と
 * サーバー側 RPC の検証で担保する**（例: answers の (room_id, question_id, participant_id)、
 * room_members の (room_id, lower(nickname)) など）。
 *
 * 状態は「進行状態」ではなく短命なカウンタのみを保持する。
 * ルームの進行状態をインスタンスメモリへ置いてはならない。
 */

import { createHash } from 'node:crypto';
import { AppError } from '@/lib/errors/app-error';

export type RateLimitOptions = {
  /** windowMs の間に許可する回数。 */
  limit: number;
  /** ウィンドウ長 (ミリ秒)。 */
  windowMs: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

/** キーごとのカウンタ。プロセス終了で消える前提。 */
const buckets = new Map<string, Bucket>();

/** メモリ肥大を避けるための上限。超えたら期限切れを掃除する。 */
const MAX_TRACKED_KEYS = 10_000;

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

/**
 * 上限を超えていれば AppError('RATE_LIMITED') を投げる。
 * 超えていなければカウンタを 1 増やして戻る。
 */
export function checkRateLimit(key: string, options: RateLimitOptions): void {
  const now = Date.now();
  const windowMs = Math.max(1, Math.trunc(options.windowMs));
  const limit = Math.max(1, Math.trunc(options.limit));

  if (buckets.size > MAX_TRACKED_KEYS) {
    sweep(now);
  }

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    throw new AppError('RATE_LIMITED', { details: { retryAfterSeconds } });
  }

  existing.count += 1;
}

/** 現在の残り回数を返す（デバッグ・診断用。判定には使わない）。 */
export function peekRateLimit(key: string, options: RateLimitOptions): number {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= Date.now()) {
    return options.limit;
  }
  return Math.max(0, options.limit - bucket.count);
}

/** テスト用にカウンタを初期化する。 */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * X-Forwarded-For の先頭 IP をハッシュ化してキーへ使う。
 * 生 IP はメモリにもログにも残さない。
 */
export function clientKeyFromRequest(request: Request, salt: string): string {
  const ip = clientIpFromRequest(request) ?? 'unknown';
  const digest = createHash('sha256').update(`${salt}:${ip}`, 'utf8').digest('hex');
  return `${salt}:${digest.slice(0, 32)}`;
}

/**
 * 信頼できるプロキシ (Cloud Run のロードバランサ) が付与した X-Forwarded-For の
 * 先頭要素をクライアント IP とみなす。CAPTCHA 検証へ渡す用途にだけ使い、保存しない。
 */
export function clientIpFromRequest(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first && first.length > 0) {
      return first;
    }
  }
  const real = request.headers.get('x-real-ip');
  return real && real.trim().length > 0 ? real.trim() : null;
}
