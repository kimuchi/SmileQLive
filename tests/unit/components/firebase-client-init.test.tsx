import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FirebaseClientModule from '@/infrastructure/firebase/client';

/**
 * 管理ログイン画面での初期化漏れの回帰テスト。
 *
 * 初期化は useFirebaseAuth / useOptionalFirestore などのフックの中でだけ行われており、
 * それらを使わない管理ログイン画面では未初期化のまま signInWithGoogle() が呼ばれ、
 *   詳細コード: Error
 * としか出ない状態で失敗していた。
 * 「先にフックを呼んでおくこと」という暗黙の順序に依存させない。
 */

const initializeFirebaseClient = vi.fn();

vi.mock('@/infrastructure/firebase/client', async () => {
  const actual = await vi.importActual<typeof FirebaseClientModule>(
    '@/infrastructure/firebase/client',
  );
  return {
    ...actual,
    initializeFirebaseClient: (config: unknown) => initializeFirebaseClient(config),
    getFirebaseAuth: vi.fn(),
    getFirebaseDb: vi.fn(),
  };
});

const { RuntimeConfigProvider } = await import('@/components/shared/runtime-config-provider');

const CONFIG = {
  firebaseApiKey: 'AIzaSyEXAMPLE',
  firebaseAuthDomain: 'example.firebaseapp.com',
  firebaseProjectId: 'example',
  firebaseStorageBucket: 'example.firebasestorage.app',
  firebaseAppId: null,
  firestoreDatabaseId: 'smileq-live',
  appBaseUrl: 'https://example.jp',
  allowedAuthDomains: [],
  turnstileSiteKey: null,
};

describe('RuntimeConfigProvider', () => {
  beforeEach(() => {
    initializeFirebaseClient.mockClear();
  });

  it('フックを使わない子でも Firebase を初期化する', () => {
    // 子は useFirebaseAuth も useOptionalFirestore も呼ばない（管理ログイン画面と同じ形）。
    render(
      <RuntimeConfigProvider value={CONFIG}>
        <div>ログイン</div>
      </RuntimeConfigProvider>,
    );

    expect(initializeFirebaseClient).toHaveBeenCalledTimes(1);
    expect(initializeFirebaseClient).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: CONFIG.firebaseApiKey,
        authDomain: CONFIG.firebaseAuthDomain,
        projectId: CONFIG.firebaseProjectId,
        firestoreDatabaseId: 'smileq-live',
      }),
    );
  });

  it('設定が欠けていても描画を止めない（各画面が構成エラーを出す）', () => {
    const incomplete = { ...CONFIG, firebaseApiKey: '' };

    expect(() =>
      render(
        <RuntimeConfigProvider value={incomplete}>
          <div>ログイン</div>
        </RuntimeConfigProvider>,
      ),
    ).not.toThrow();
    expect(initializeFirebaseClient).not.toHaveBeenCalled();
  });

  it('初期化が失敗しても描画を止めない', () => {
    initializeFirebaseClient.mockImplementationOnce(() => {
      throw new Error('初期化に失敗');
    });

    expect(() =>
      render(
        <RuntimeConfigProvider value={CONFIG}>
          <div>ログイン</div>
        </RuntimeConfigProvider>,
      ),
    ).not.toThrow();
  });
});
