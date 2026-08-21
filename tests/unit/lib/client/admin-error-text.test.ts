import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/lib/client/api-client';
import { toAdminErrorMessage, toUserErrorMessage } from '@/lib/client/error-text';

/**
 * 管理画面のエラー文。
 *
 * 「画像を…できませんでした」だけだと、画像が悪いのか保存先の設定が悪いのかが分からず、
 * 直しようがなかった。管理者しか見ない画面なので、原因が分かっているなら添える。
 * 参加者向けの文（toUserErrorMessage）には添えない。
 */
describe('管理画面向けのエラー文', () => {
  it('サーバーが理由を添えていれば一緒に出す', () => {
    const error = new ApiClientError({
      code: 'MEDIA_STORAGE_FAILED',
      message: 'サーバーの文言',
      status: 502,
      requestId: 'req-1',
      details: { reason: 'バケット example が見つかりません' },
    });

    expect(toAdminErrorMessage(error)).toContain('バケット example が見つかりません');
  });

  it('理由が無ければ従来どおりの文だけ', () => {
    const error = new ApiClientError({
      code: 'MEDIA_TOO_LARGE',
      message: 'サーバーの文言',
      status: 422,
      requestId: 'req-2',
    });

    expect(toAdminErrorMessage(error)).toBe(toUserErrorMessage(error));
  });

  it('参加者向けの文には理由を混ぜない', () => {
    // 会場のスマートフォンへ、保存先やサービスアカウントの話を出さない。
    const error = new ApiClientError({
      code: 'MEDIA_STORAGE_FAILED',
      message: 'サーバーの文言',
      status: 502,
      requestId: 'req-3',
      details: { reason: 'バケット example が見つかりません' },
    });

    expect(toUserErrorMessage(error)).not.toContain('バケット');
  });

  it('理由が文字列でなければ無視する', () => {
    const error = new ApiClientError({
      code: 'MEDIA_STORAGE_FAILED',
      message: 'サーバーの文言',
      status: 502,
      requestId: 'req-4',
      details: { reason: { nested: true } },
    });

    expect(toAdminErrorMessage(error)).toBe(toUserErrorMessage(error));
  });
});
