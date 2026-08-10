import type { ReactNode } from 'react';
import { cn } from '@/lib/client/cn';

/**
 * 情報のまとまりを囲む枠。
 * 投影画面ではなく、参加者・管理・司会画面で使う想定の明るい配色。
 */

export type CardProps = {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  padded?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
};

export function Card({
  title,
  description,
  actions,
  footer,
  padded = true,
  className,
  bodyClassName,
  children,
}: CardProps) {
  const hasHeader = title !== undefined || description !== undefined || actions !== undefined;

  return (
    <section className={cn('rounded-2xl border border-slate-200 bg-white shadow-sm', className)}>
      {hasHeader ? (
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title !== undefined ? (
              <h2 className="text-base font-bold text-slate-900">{title}</h2>
            ) : null}
            {description !== undefined ? (
              <p className="mt-1 text-sm text-slate-600">{description}</p>
            ) : null}
          </div>
          {actions !== undefined ? <div className="shrink-0">{actions}</div> : null}
        </header>
      ) : null}

      <div className={cn(padded ? 'px-4 py-4 sm:px-5' : undefined, bodyClassName)}>{children}</div>

      {footer !== undefined ? (
        <footer className="border-t border-slate-100 px-4 py-3 sm:px-5">{footer}</footer>
      ) : null}
    </section>
  );
}
