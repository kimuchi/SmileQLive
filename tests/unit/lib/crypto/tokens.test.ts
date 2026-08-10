import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// tokens.ts はサーバー専用モジュールなので 'server-only' を無効化してから読み込む。
vi.mock('server-only', () => ({}));

const {
  createJoinToken,
  createPresentationToken,
  hashToken,
  isPlausibleToken,
  redactPath,
  redactToken,
  safeEqualHex,
  JOIN_TOKEN_MIN_BYTES,
  PRESENTATION_TOKEN_BYTES,
} = await import('@/lib/crypto/tokens');

/**
 * 参加トークンは「推測困難であること」と「平文が漏れないこと」の 2 点が要。
 * 仕様書 §33 / §35 に対応する。
 */
describe('参加トークンの生成', () => {
  beforeEach(() => {
    delete process.env.JOIN_TOKEN_BYTES;
  });

  it('128ビット以上の乱数から URL-safe な文字列を作る', () => {
    const { token } = createJoinToken();
    // 16 bytes を base64url にすると 22 文字
    expect(token.length).toBeGreaterThanOrEqual(22);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // base64url なので URL エンコードが不要（+ / = を含まない）
    expect(token).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('毎回異なるトークンを返す', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => createJoinToken().token));
    expect(tokens.size).toBe(200);
  });

  it('JOIN_TOKEN_BYTES で長さを増やせるが、下限を下回らせない', () => {
    process.env.JOIN_TOKEN_BYTES = '32';
    expect(createJoinToken().token.length).toBeGreaterThan(32);

    // 下限未満を指定しても 16 bytes 未満にはしない
    process.env.JOIN_TOKEN_BYTES = '4';
    expect(createJoinToken().token.length).toBeGreaterThanOrEqual(22);

    process.env.JOIN_TOKEN_BYTES = 'not-a-number';
    expect(createJoinToken().token.length).toBeGreaterThanOrEqual(22);
  });

  it('下限は 128 ビット (16 bytes)', () => {
    expect(JOIN_TOKEN_MIN_BYTES).toBe(16);
  });

  it('投影用トークンは 32 bytes 以上', () => {
    expect(PRESENTATION_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
    const { token } = createPresentationToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('トークンのハッシュ化', () => {
  it('SHA-256 の 16進 64 文字を返す', () => {
    const { token, tokenHash } = createJoinToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
  });

  it('同じ入力からは同じハッシュになる', () => {
    expect(hashToken('same-input')).toBe(hashToken('same-input'));
  });

  it('1文字違えば別のハッシュになる', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
  });

  it('ハッシュから平文は復元できない（片方向であることの確認）', () => {
    const { token, tokenHash } = createJoinToken();
    expect(tokenHash).not.toContain(token);
    expect(token).not.toContain(tokenHash);
  });
});

describe('トークン形式の事前検証', () => {
  it('妥当な形式を受け付ける', () => {
    expect(isPlausibleToken(createJoinToken().token)).toBe(true);
    expect(isPlausibleToken(createPresentationToken().token)).toBe(true);
  });

  it('短すぎる・長すぎる・不正な文字を拒否する', () => {
    expect(isPlausibleToken('short')).toBe(false);
    expect(isPlausibleToken('a'.repeat(65))).toBe(false);
    expect(isPlausibleToken('has spaces in it here')).toBe(false);
    expect(isPlausibleToken('has/slash+plus=equals!')).toBe(false);
    expect(isPlausibleToken('')).toBe(false);
    // SQL/パス断片のような入力も弾く
    expect(isPlausibleToken('../../etc/passwd')).toBe(false);
  });
});

describe('定数時間比較', () => {
  it('同じ 16進文字列で true', () => {
    const hash = hashToken('value');
    expect(safeEqualHex(hash, hash)).toBe(true);
  });

  it('異なる値・長さ違いで false', () => {
    expect(safeEqualHex(hashToken('a'), hashToken('b'))).toBe(false);
    expect(safeEqualHex('abcd', 'abcdef')).toBe(false);
  });

  it('16進として不正な文字列は、同じ文字列同士でも false にする', () => {
    // Buffer.from(x, 'hex') は不正な文字を捨てて空バッファを返すため、
    // 形式検証をしないと「不正な文字列同士」が一致してしまう。
    expect(safeEqualHex('zzzz', 'zzzz')).toBe(false);
    expect(safeEqualHex('....', '....')).toBe(false);
    expect(safeEqualHex('abcg', 'abcg')).toBe(false);
    // 奇数長も受け付けない
    expect(safeEqualHex('abc', 'abc')).toBe(false);
    // 空文字も一致させない
    expect(safeEqualHex('', '')).toBe(false);
  });

  it('例外を投げない', () => {
    expect(() => safeEqualHex('日本語', '日本語')).not.toThrow();
    expect(safeEqualHex('日本語', '日本語')).toBe(false);
  });
});

describe('ログ出力時のマスキング', () => {
  it('トークンは常に [redacted] になる', () => {
    expect(redactToken(createJoinToken().token)).toBe('[redacted]');
  });

  it('参加URLのパスからトークンを取り除く', () => {
    expect(redactPath('/j/AbCdEfGhIjKlMnOpQrStUv')).toBe('/j/[redacted]');
    expect(redactPath('/api/join/AbCdEfGhIjKlMnOpQrStUv/resolve')).toBe(
      '/api/join/[redacted]/resolve',
    );
    expect(redactPath('/api/join/AbCdEfGhIjKlMnOpQrStUv/register')).toBe(
      '/api/join/[redacted]/register',
    );
    expect(redactPath('/present/token/AbCdEfGhIjKlMnOpQrStUv')).toBe('/present/token/[redacted]');
  });

  it('マスク後の文字列にトークンが残らない', () => {
    const { token } = createJoinToken();
    for (const path of [`/j/${token}`, `/api/join/${token}/resolve`, `/present/token/${token}`]) {
      expect(redactPath(path)).not.toContain(token);
    }
  });

  it('トークンを含まないパスは変更しない', () => {
    expect(redactPath('/play/room-123')).toBe('/play/room-123');
    expect(redactPath('/api/health')).toBe('/api/health');
    expect(redactPath('/admin/quizzes')).toBe('/admin/quizzes');
  });
});
