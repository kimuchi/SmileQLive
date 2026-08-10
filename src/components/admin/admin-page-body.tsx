import type { ReactNode } from 'react';
import { cn } from '@/lib/client/cn';

/**
 * 管理画面の本文枠。
 * 見出しと操作の位置を全ページでそろえる（Server Component として使える純表示）。
 */

export type AdminPageBodyProps = {
  title: ReactNode;
  description?: ReactNode;
  /** 見出し右の操作。 */
  actions?: ReactNode;
  /** 見出し上の補助リンク（戻る導線など）。 */
  breadcrumb?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function AdminPageBody({
  title,
  description,
  actions,
  breadcrumb,
  className,
  children,
}: AdminPageBodyProps) {
  return (
    <main className={cn('mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8', className)}>
      {breadcrumb !== undefined ? <div className="mb-3 text-sm">{breadcrumb}</div> : null}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
          {description !== undefined ? (
            <p className="mt-1 text-sm text-slate-600">{description}</p>
          ) : null}
        </div>
        {actions !== undefined ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children}
    </main>
  );
}
