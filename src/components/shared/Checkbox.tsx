'use client';

import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { FieldError, FieldHint } from '@/components/shared/FieldLabel';
import { cn } from '@/lib/client/cn';

/**
 * チェックボックス。
 * ラベル全体をタップ領域にし、行の高さを 44px 以上にする。
 */

export type CheckboxProps = Omit<ComponentPropsWithRef<'input'>, 'id' | 'className' | 'type'> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  id?: string;
  className?: string;
};

export function Checkbox({ label, hint, error, id, className, ...rest }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  const describedBy = cn(hint !== undefined && hintId, error !== undefined && errorId) || undefined;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label
        htmlFor={inputId}
        className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-slate-800"
      >
        <input
          {...rest}
          id={inputId}
          type="checkbox"
          aria-invalid={error !== undefined || undefined}
          aria-describedby={describedBy}
          className={cn(
            'text-brand-600 accent-brand-600 size-5 shrink-0 rounded border-slate-400',
            'focus-visible:outline-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2',
            'disabled:cursor-not-allowed',
          )}
        />
        <span className="font-bold">{label}</span>
      </label>
      {hint !== undefined ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
      {error !== undefined ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
