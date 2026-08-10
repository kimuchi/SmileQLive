import type { ReactNode } from 'react';
import { cn } from '@/lib/client/cn';

/**
 * 注意・完了・エラーの通知。
 * エラーだけ role="alert" とし、それ以外は読み上げを割り込ませない。
 */

export type AlertVariant = 'info' | 'success' | 'warning' | 'error';

const VARIANT_CLASS: Record<AlertVariant, string> = {
  info: 'border-sky-200 bg-sky-50 text-sky-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  error: 'border-red-200 bg-red-50 text-red-900',
};

const VARIANT_MARK: Record<AlertVariant, string> = {
  info: 'お知らせ',
  success: '完了',
  warning: '注意',
  error: 'エラー',
};

export type AlertProps = {
  variant?: AlertVariant;
  title?: ReactNode;
  className?: string;
  /** 右端に置く操作（「もう一度試す」など）。 */
  actions?: ReactNode;
  children?: ReactNode;
};

export function Alert({ variant = 'info', title, className, actions, children }: AlertProps) {
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm',
        VARIANT_CLASS[variant],
        className,
      )}
    >
      <div className="min-w-0">
        <span className="sr-only">{VARIANT_MARK[variant]}: </span>
        {title !== undefined ? <p className="font-bold">{title}</p> : null}
        {children !== undefined ? (
          <div className={cn(title !== undefined && 'mt-1')}>{children}</div>
        ) : null}
      </div>
      {actions !== undefined ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
