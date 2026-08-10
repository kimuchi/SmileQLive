import type { Metadata } from 'next';
import { LoginPanel } from '@/components/admin/login-panel';
import { checkServerConfiguration } from '@/lib/env/server-env';

/**
 * 管理・司会のログイン画面。
 *
 * middleware がここだけを認証不要パスとして扱う。
 * 参加者はこの画面を使わない（参加は二次元コードの参加URLのみ）。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ログイン | SmileQ Live',
  robots: { index: false, follow: false },
};

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;

  // 参加トークンを含む URL は管理系パスに存在しないため、そのまま次遷移先として扱ってよい。
  const nextPath = typeof rawNext === 'string' && rawNext.length > 0 ? rawNext : '/admin/quizzes';

  const configuration = checkServerConfiguration();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 text-center">
        <p className="text-brand-700 text-2xl font-bold">SmileQ Live</p>
        <p className="mt-1 text-sm text-slate-600">会場イベント向けリアルタイムクイズ</p>
      </div>
      <LoginPanel missingServerEnv={configuration.missing} nextPath={nextPath} />
    </main>
  );
}
