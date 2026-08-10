'use client';

import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { FieldError, FieldHint, FieldLabel } from '@/components/shared/FieldLabel';
import { cn } from '@/lib/client/cn';

/**
 * 1 行テキスト入力。
 *
 * - iOS Safari の自動ズームを避けるため文字サイズは 16px（globals.css で指定済み）。
 * - タップ領域を 44px 以上にする。
 * - エラーは aria-describedby / aria-invalid で読み上げへ渡す。
 * - react-hook-form の register をそのまま展開できるよう ref を受け取る。
 */

export type TextInputProps = Omit<ComponentPropsWithRef<'input'>, 'id' | 'className'> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** 明示的に id を指定したいとき。省略時は useId で採番する。 */
  id?: string;
  className?: string;
  inputClassName?: string;
};

export function TextInput({
  label,
  hint,
  error,
  id,
  required,
  className,
  inputClassName,
  type,
  ...rest
}: TextInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  const describedBy = cn(hint !== undefined && hintId, error !== undefined && errorId) || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <FieldLabel htmlFor={inputId} required={required}>
        {label}
      </FieldLabel>
      <input
        {...rest}
        id={inputId}
        type={type ?? 'text'}
        required={required}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
        className={cn(
          'min-h-12 w-full rounded-xl border bg-white px-3.5 py-2.5 text-slate-900',
          'placeholder:text-slate-400',
          'focus-visible:outline-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2',
          'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500',
          error !== undefined ? 'border-red-400' : 'border-slate-300',
          inputClassName,
        )}
      />
      {hint !== undefined ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
      {error !== undefined ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
