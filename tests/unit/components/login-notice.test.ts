import { FirebaseError } from 'firebase/app';
import { describe, expect, it } from 'vitest';

import { toLoginNotice } from '@/components/admin/login-form';
import { ApiClientError } from '@/lib/client/api-client';

/**
 * ログイン失敗の案内。
 *
 * この画面を見るのは運営担当者だけで、設定不備は本人には直せない。
 * 実際に「ログインできませんでした / 時間をおいて、もう一度お試しください」だけが出て、
 * Google プロバイダが未有効であることに気付けず詰まった。
 * 原因が特定できる情報（コード）を必ず残すこと。
 */
function firebaseError(code: string): FirebaseError {
  return new FirebaseError(code, `${code} が発生しました`);
}

describe('toLoginNotice', () => {
  it('利用者が自分で閉じた場合はエラーを出さない', () => {
    expect(toLoginNotice(firebaseError('auth/popup-closed-by-user'), [])).toBeNull();
    expect(toLoginNotice(firebaseError('auth/cancelled-popup-request'), [])).toBeNull();
    expect(toLoginNotice(firebaseError('auth/user-cancelled'), [])).toBeNull();
  });

  it('Google プロバイダ未有効を「設定が済むまで直らない」と伝える', () => {
    for (const code of ['auth/operation-not-allowed', 'auth/configuration-not-found']) {
      const notice = toLoginNotice(firebaseError(code), []);

      expect(notice?.title).toContain('Google ログインが有効になっていません');
      expect(notice?.description).toContain('何度試しても');
      expect(notice?.code).toBe(code);
    }
  });

  it('承認済みドメイン漏れをドメインの問題として伝える', () => {
    const notice = toLoginNotice(firebaseError('auth/unauthorized-domain'), []);

    expect(notice?.title).toContain('ドメイン');
    expect(notice?.description).toContain('承認済みドメイン');
    expect(notice?.code).toBe('auth/unauthorized-domain');
  });

  it('未知の Firebase エラーでもコードを落とさない', () => {
    const notice = toLoginNotice(firebaseError('auth/some-new-code'), []);

    expect(notice?.code).toBe('auth/some-new-code');
  });

  it('ネットワーク断はコードを出さずに再試行を促す', () => {
    const notice = toLoginNotice(firebaseError('auth/network-request-failed'), []);

    expect(notice?.title).toContain('通信できませんでした');
    expect(notice?.code).toBeUndefined();
  });

  it('許可ドメイン外は許可ドメインを明示する', () => {
    const error = new ApiClientError({
      code: 'FORBIDDEN',
      message: '拒否されました',
      status: 403,
      requestId: 'req-1',
      details: { reason: 'domain_not_allowed' },
    });
    const notice = toLoginNotice(error, ['example.co.jp']);

    expect(notice?.description).toContain('@example.co.jp');
  });

  it('サーバー側の失敗はメッセージとコードを見せる', () => {
    const error = new ApiClientError({
      code: 'INTERNAL_ERROR',
      message: 'セッションを発行できませんでした',
      status: 500,
      requestId: 'req-2',
    });
    const notice = toLoginNotice(error, []);

    expect(notice?.description).toBe('セッションを発行できませんでした');
    expect(notice?.code).toBe('INTERNAL_ERROR');
  });

  it('正解や ID トークンを案内へ混ぜない', () => {
    const notice = toLoginNotice(firebaseError('auth/internal-error'), []);
    const text = `${notice?.title} ${notice?.description} ${notice?.code}`;

    expect(text).not.toMatch(/idToken|Bearer|eyJ/);
  });
});
