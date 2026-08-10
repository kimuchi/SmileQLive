'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from '@/components/shared/Spinner';
import { cn } from '@/lib/client/cn';

/**
 * 共通ボタン。
 *
 * 会場で立ったまま操作するため、最小タップ領域を 44px 以上にする。
 * loading 中は自動的に無効化し、二重送信を防ぐ。
 */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white border border-transparent hover:bg-brand-700 active:bg-brand-800 focus-visible:outline-brand-600',
  secondary:
    'bg-white text-brand-700 border border-brand-300 hover:bg-brand-50 active:bg-brand-100 focus-visible:outline-brand-600',
  danger:
    'bg-red-600 text-white border border-transparent hover:bg-red-700 active:bg-red-800 focus-visible:outline-red-600',
  ghost:
    'bg-transparent text-slate-700 border border-transparent hover:bg-slate-100 active:bg-slate-200 focus-visible:outline-slate-500',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  // min-h-11 = 44px。iOS の最小タップ領域を下回らせない。
  sm: 'min-h-11 min-w-11 px-3 py-2 text-sm gap-1.5',
  md: 'min-h-12 min-w-12 px-5 py-2.5 text-base gap-2',
  lg: 'min-h-14 min-w-14 px-7 py-3 text-lg gap-2.5',
};

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  /** ボタン左に置くアイコン等。loading 中は spinner に置き換わる。 */
  leading?: ReactNode;
  children?: ReactNode;
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  leading,
  disabled,
  className,
  type,
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled === true || loading;

  return (
    <button
      {...rest}
      type={type ?? 'button'}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-xl font-bold transition-colors select-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        fullWidth && 'w-full',
        className,
      )}
    >
      {loading ? <Spinner size="sm" decorative /> : leading}
      <span>{children}</span>
      {loading ? <span className="sr-only">処理中です</span> : null}
    </button>
  );
}
