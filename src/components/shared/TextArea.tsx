'use client';

import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { FieldError, FieldHint, FieldLabel } from '@/components/shared/FieldLabel';
import { cn } from '@/lib/client/cn';

/** 複数行テキスト入力（問題文・解説など）。 */

export type TextAreaProps = Omit<ComponentPropsWithRef<'textarea'>, 'id' | 'className'> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  id?: string;
  className?: string;
  textAreaClassName?: string;
  /** 入力済み文字数 / 上限の表示。maxLength と併用する。 */
  showCounter?: boolean;
  value?: string;
};

export function TextArea({
  label,
  hint,
  error,
  id,
  required,
  className,
  textAreaClassName,
  rows,
  showCounter = false,
  maxLength,
  value,
  ...rest
}: TextAreaProps) {
  const generatedId = useId();
  const textAreaId = id ?? generatedId;
  const hintId = `${textAreaId}-hint`;
  const errorId = `${textAreaId}-error`;

  const describedBy = cn(hint !== undefined && hintId, error !== undefined && errorId) || undefined;
  const showLength = showCounter && typeof maxLength === 'number' && typeof value === 'string';

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <FieldLabel htmlFor={textAreaId} required={required}>
        {label}
      </FieldLabel>
      <textarea
        {...rest}
        id={textAreaId}
        rows={rows ?? 4}
        required={required}
        maxLength={maxLength}
        value={value}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
        className={cn(
          'w-full rounded-xl border bg-white px-3.5 py-2.5 leading-relaxed text-slate-900',
          'placeholder:text-slate-400',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
          'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500',
          error !== undefined ? 'border-red-400' : 'border-slate-300',
          textAreaClassName,
        )}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {hint !== undefined ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
          {error !== undefined ? <FieldError id={errorId}>{error}</FieldError> : null}
        </div>
        {showLength ? (
          <p className="shrink-0 text-xs text-slate-500 tabular-nums">
            {value.length} / {maxLength}
          </p>
        ) : null}
      </div>
    </div>
  );
}
