'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { FirebaseError } from 'firebase/app';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { useRuntimeConfig } from '@/components/shared/runtime-config-provider';
import {
  exchangeSessionCookie,
  signInWithGoogle,
  signOutEverywhere,
} from '@/infrastructure/firebase/client';
import { ApiClientError } from '@/lib/client/api-client';

/**
 * 管理・司会のログイン。
 *
 * 守ること:
 * - **Google Workspace アカウントの Google ログインのみ。** メール＋パスワードは扱わない。
 * - **自己登録（サインアップ）への導線を置かない。** 利用者は管理者が招待する。
 *   Google でサインインできること（＝ Google アカウントを持っていること）と、
 *   司会者であること（＝ `profiles/{uid}` があること）は別物（docs/HOST_ACCESS.md §2）。
 * - 権限が無いアカウントは「管理権限がありません」と伝えて**サインアウトさせる**。
 *   中途半端にログイン状態を残さない。
 * - 許可ドメイン外のアカウントは、原因が分かる日本語で伝える。
 * - ID トークンをこの層で保持しない（`signInWithGoogle` の内部で
 *   HttpOnly のセッションクッキーへ交換される）。ログ・URL へも出さない。
 * - Firebase の公開設定が無いときは、ログイン失敗ではなく「構成エラー」として原因を明示する。
 */

export type LoginPanelProps = {
  /** サーバー側で検出した不足設定。 */
  missingServerEnv: string[];
  /** ログイン後の遷移先（管理系パスのみ許可）。 */
  nextPath: string;
};

/** オープンリダイレクトを避けるため、自サイトの管理系パスだけを許可する。 */
function safeNextPath(candidate: string): string {
  if (!candidate.startsWith('/') || candidate.startsWith('//')) {
    return '/admin/quizzes';
  }
  if (candidate.startsWith('/admin/login')) {
    return '/admin/quizzes';
  }
  if (candidate.startsWith('/admin/') || candidate.startsWith('/host/')) {
    return candidate;
  }
  return '/admin/quizzes';
}

/** 画面に出す案内。ここに技術用語・エラーコードを混ぜない。 */
type LoginNotice = { title: string; description: string };

const NO_PERMISSION_NOTICE: LoginNotice = {
  title: 'この Google アカウントには管理権限がありません',
  description:
    'ログイン自体は成功しましたが、司会者として登録されていません。運営管理者へ登録を依頼してください',
};

function domainNotAllowedNotice(allowedDomains: string[]): LoginNotice {
  const allowed =
    allowedDomains.length > 0
      ? `ログインできるのは ${allowedDomains.map((domain) => `@${domain}`).join(' / ')} のアカウントだけです`
      : '会社から案内された Google Workspace アカウントでログインしてください';
  return { title: 'このアカウントではログインできません', description: allowed };
}

/**
 * Firebase Auth / セッション交換の失敗を日本語の案内へ丸める。
 * 利用者が自分で解決できない失敗（設定不備・通信断）は素直にそう伝える。
 */
function toLoginNotice(error: unknown, allowedDomains: string[]): LoginNotice | null {
  if (error instanceof FirebaseError) {
    switch (error.code) {
      case 'auth/popup-closed-by-user':
      case 'auth/cancelled-popup-request':
      case 'auth/user-cancelled':
        // 利用者が自分で閉じただけ。エラー表示は出さない。
        return null;
      case 'auth/popup-blocked':
        return {
          title: 'ログイン画面を開けませんでした',
          description:
            'ブラウザがポップアップを block しています。ポップアップを許可してから、もう一度お試しください',
        };
      case 'auth/network-request-failed':
        return {
          title: '通信できませんでした',
          description: 'ネットワークの状況を確認して、もう一度お試しください',
        };
      case 'auth/unauthorized-domain':
      case 'auth/operation-not-allowed':
        return {
          title: 'ログインの設定が完了していません',
          description:
            'Firebase Authentication の Google ログインと承認済みドメインの設定を確認してください',
        };
      default:
        return {
          title: 'ログインできませんでした',
          description: '時間をおいて、もう一度お試しください',
        };
    }
  }

  if (error instanceof ApiClientError) {
    const reason =
      typeof error.details === 'object' && error.details !== null
        ? (error.details as { reason?: unknown }).reason
        : undefined;

    if (reason === 'domain_not_allowed') {
      return domainNotAllowedNotice(allowedDomains);
    }
    if (reason === 'email_not_verified') {
      return {
        title: 'このアカウントではログインできません',
        description: 'メールアドレスが確認済みの Google Workspace アカウントでログインしてください',
      };
    }
    if (reason === 'unsupported_provider') {
      return {
        title: 'このログイン方法は利用できません',
        description: 'Google Workspace アカウントでログインしてください',
      };
    }
    if (error.isNetworkError) {
      return {
        title: '通信できませんでした',
        description: 'ネットワークの状況を確認して、もう一度お試しください',
      };
    }
    return { title: 'ログインできませんでした', description: error.message };
  }

  return { title: 'ログインできませんでした', description: '時間をおいて、もう一度お試しください' };
}

export function LoginPanel({ missingServerEnv, nextPath }: LoginPanelProps) {
  const config = useRuntimeConfig();
  const clientConfigured =
    config.firebaseApiKey.length > 0 &&
    config.firebaseAuthDomain.length > 0 &&
    config.firebaseProjectId.length > 0;

  const missing = [
    ...new Set([...missingServerEnv, ...(clientConfigured ? [] : ['FIREBASE_API_KEY'])]),
  ];

  if (!clientConfigured || missingServerEnv.length > 0) {
    return <ConfigurationError missing={missing} />;
  }

  return <LoginForm nextPath={nextPath} />;
}

function ConfigurationError({ missing }: { missing: string[] }) {
  return (
    <Card title="構成エラー">
      <Alert variant="error" title="サーバー設定が不足しています">
        <p>この環境ではログインできません。次の環境変数を設定してから再起動してください。</p>
        <ul className="mt-2 list-disc pl-5 font-mono text-xs">
          {missing.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
        <p className="mt-2">
          設定状況は <span className="font-mono">/api/diagnostics</span> でも確認できます。
        </p>
      </Alert>
    </Card>
  );
}

export function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const { allowedAuthDomains } = useRuntimeConfig();

  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<LoginNotice | null>(null);

  const handleGoogleLogin = useCallback(async () => {
    if (submitting) {
      return;
    }
    setNotice(null);
    setSubmitting(true);

    try {
      // Google ログイン → ID トークン → セッションクッキー発行までを行う。
      // 許可ドメインの判定はサーバー（/api/auth/session）が行う。
      await signInWithGoogle({ allowedDomains: allowedAuthDomains });

      // 司会者として登録されているか（profiles/{uid} の有無）はサーバーだけが知っている。
      // signInWithGoogle は uid しか返さないため、ここで判定結果を受け取る。
      const session = await exchangeSessionCookie();

      if (!session.isHost) {
        // ログインはできたが管理権限が無い。状態を残さずサインアウトさせる。
        setNotice(NO_PERMISSION_NOTICE);
        await signOutEverywhere().catch(() => undefined);
        return;
      }

      router.replace(safeNextPath(nextPath));
      router.refresh();
    } catch (caught) {
      setNotice(toLoginNotice(caught, allowedAuthDomains));
      // 失敗したまま「サインイン済み」を残さない。失敗しても画面は続行する。
      await signOutEverywhere().catch(() => undefined);
    } finally {
      setSubmitting(false);
    }
  }, [allowedAuthDomains, nextPath, router, submitting]);

  return (
    <Card
      title="ログイン"
      description="管理者から案内された Google Workspace アカウントでログインしてください。"
    >
      <div className="flex flex-col gap-4">
        {notice !== null ? (
          <Alert variant="error" title={notice.title}>
            {notice.description}
          </Alert>
        ) : null}

        <Button
          type="button"
          size="lg"
          fullWidth
          loading={submitting}
          onClick={() => {
            void handleGoogleLogin();
          }}
        >
          Google Workspace アカウントでログイン
        </Button>

        <p className="text-xs leading-relaxed text-slate-600">
          このシステムに自分でアカウントを作ることはできません。
          <br />
          利用開始・権限の追加は運営管理者へご連絡ください。
        </p>
      </div>
    </Card>
  );
}
