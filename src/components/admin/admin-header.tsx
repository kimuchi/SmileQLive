'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { Button } from '@/components/shared/Button';
import { useIsConfigured } from '@/components/shared/runtime-config-provider';
import { signOutEverywhere } from '@/infrastructure/firebase/client';
import { cn } from '@/lib/client/cn';

/**
 * 管理・司会画面の上部バー。
 *
 * ルームコードの概念は存在しないため、コード入力への導線は置かない。
 * 参加はすべて二次元コード（参加URL）から行う。
 */

export type AdminHeaderNav = 'quizzes' | 'rooms' | 'none';

const NAV_ITEMS: ReadonlyArray<{ key: AdminHeaderNav; href: string; label: string }> = [
  { key: 'quizzes', href: '/admin/quizzes', label: 'クイズ一覧' },
  // 司会画面へ戻る導線。ルーム作成直後の画面を離れても進行へ復帰できるようにする。
  { key: 'rooms', href: '/admin/rooms', label: 'ルーム一覧' },
];

export type AdminHeaderProps = {
  current?: AdminHeaderNav;
  /** 右側に追加で置く操作。 */
  actions?: React.ReactNode;
};

export function AdminHeader({ current = 'none', actions }: AdminHeaderProps) {
  const router = useRouter();
  const configured = useIsConfigured();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = useCallback(async () => {
    if (!configured) {
      return;
    }
    setSigningOut(true);
    try {
      // セッションクッキーの破棄（サーバー）とブラウザ側サインアウトの両方を行う。
      await signOutEverywhere();
    } catch {
      // 失敗してもログイン画面へは戻す（サーバー側の Cookie は middleware が判定する）。
    } finally {
      setSigningOut(false);
      router.replace('/admin/login');
      router.refresh();
    }
  }, [configured, router]);

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <Link
          href="/admin/quizzes"
          className="focus-visible:outline-brand-600 rounded-lg text-base font-bold text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          SmileQ Live
          <span className="ml-2 text-xs font-bold text-slate-500">管理画面</span>
        </Link>

        <nav aria-label="管理メニュー" className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={current === item.key ? 'page' : undefined}
              className={cn(
                'focus-visible:outline-brand-600 inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2',
                current === item.key
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {actions}
          <Button variant="ghost" size="sm" loading={signingOut} onClick={handleSignOut}>
            ログアウト
          </Button>
        </div>
      </div>
    </header>
  );
}
