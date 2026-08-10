'use client';

import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { FieldError, FieldHint, FieldLabel } from '@/components/shared/FieldLabel';
import { cn } from '@/lib/client/cn';

/** 単一選択のプルダウン。選択肢は options で渡す。 */

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SelectProps = Omit<
  ComponentPropsWithRef<'select'>,
  'id' | 'className' | 'children'
> & {
  label: ReactNode;
  options: readonly SelectOption[];
  hint?: ReactNode;
  error?: ReactNode;
  /** 未選択時に先頭へ出す項目。 */
  placeholder?: string;
  id?: string;
  className?: string;
  selectClassName?: string;
};

export function Select({
  label,
  options,
  hint,
  error,
  placeholder,
  id,
  required,
  className,
  selectClassName,
  ...rest
}: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const hintId = `${selectId}-hint`;
  const errorId = `${selectId}-error`;

  const describedBy = cn(hint !== undefined && hintId, error !== undefined && errorId) || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <FieldLabel htmlFor={selectId} required={required}>
        {label}
      </FieldLabel>
      <select
        {...rest}
        id={selectId}
        required={required}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
        className={cn(
          'min-h-12 w-full rounded-xl border bg-white px-3 py-2.5 text-slate-900',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
          'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500',
          error !== undefined ? 'border-red-400' : 'border-slate-300',
          selectClassName,
        )}
      >
        {placeholder !== undefined ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {hint !== undefined ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
      {error !== undefined ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
