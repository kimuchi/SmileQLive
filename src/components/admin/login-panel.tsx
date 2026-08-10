'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { TextInput } from '@/components/shared/TextInput';
import { useRuntimeConfig, useSupabaseClient } from '@/components/shared/runtime-config-provider';

/**
 * 管理・司会のログイン。
 *
 * - 自己登録（サインアップ）への導線は置かない。利用者は管理者が招待する。
 * - SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY が無いときは、
 *   ログイン失敗ではなく「構成エラー」として原因を明示する。
 * - パスワードはログにも解析にも渡さない（送信は Supabase Auth のみ）。
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

export function LoginPanel({ missingServerEnv, nextPath }: LoginPanelProps) {
  const config = useRuntimeConfig();
  const clientConfigured =
    config.supabaseUrl.length > 0 && config.supabasePublishableKey.length > 0;
  const missing = [
    ...new Set([...missingServerEnv, ...(clientConfigured ? [] : ['SUPABASE_URL'])]),
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

function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const supabase = useSupabaseClient();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) {
        return;
      }
      setErrorMessage(null);

      if (email.trim().length === 0 || password.length === 0) {
        setErrorMessage('メールアドレスとパスワードを入力してください');
        return;
      }

      setSubmitting(true);
      try {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) {
          // Supabase の英語メッセージはそのまま出さず、日本語へ丸める。
          setErrorMessage('メールアドレスまたはパスワードが正しくありません');
          return;
        }
        setPassword('');
        router.replace(safeNextPath(nextPath));
        router.refresh();
      } catch {
        setErrorMessage('通信できませんでした。電波状況を確認して、もう一度お試しください');
      } finally {
        setSubmitting(false);
      }
    },
    [email, nextPath, password, router, submitting, supabase],
  );

  return (
    <Card title="ログイン" description="管理者から案内されたメールアドレスでログインしてください。">
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        {errorMessage !== null ? <Alert variant="error">{errorMessage}</Alert> : null}

        <TextInput
          label="メールアドレス"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.currentTarget.value);
          }}
        />

        <TextInput
          label="パスワード"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.currentTarget.value);
          }}
        />

        <Button type="submit" size="lg" fullWidth loading={submitting}>
          ログイン
        </Button>

        <p className="text-xs text-slate-600">
          アカウントの発行・パスワードの再設定は運営管理者へご連絡ください。
        </p>
      </form>
    </Card>
  );
}
