'use client';

import { useId, type ReactNode } from 'react';
import { FieldError, FieldHint } from '@/components/shared/FieldLabel';
import { cn } from '@/lib/client/cn';

/**
 * 単一選択のラジオグループ。
 *
 * - fieldset / legend で選択肢のまとまりを伝える。
 * - 各行を 44px 以上のタップ領域にする。
 * - 正解を示す色分けはここでは行わない（正解情報は発表後に別途扱う）。
 */

export type RadioOption<TValue extends string = string> = {
  value: TValue;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
};

export type RadioGroupProps<TValue extends string = string> = {
  /** input の name。同一ページで重複させない。 */
  name: string;
  legend: ReactNode;
  options: ReadonlyArray<RadioOption<TValue>>;
  value: TValue | null;
  onChange: (value: TValue) => void;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
};

export function RadioGroup<TValue extends string = string>({
  name,
  legend,
  options,
  value,
  onChange,
  hint,
  error,
  required = false,
  disabled = false,
  className,
}: RadioGroupProps<TValue>) {
  const groupId = useId();
  const hintId = `${groupId}-hint`;
  const errorId = `${groupId}-error`;

  const describedBy = cn(hint !== undefined && hintId, error !== undefined && errorId) || undefined;

  return (
    <fieldset
      className={cn('flex flex-col gap-2', className)}
      aria-describedby={describedBy}
      aria-invalid={error !== undefined || undefined}
      aria-required={required || undefined}
      disabled={disabled}
    >
      <legend className="text-sm font-bold text-slate-800">
        {legend}
        {required ? (
          <span className="ml-1 text-red-600">
            <span aria-hidden="true">*</span>
            <span className="sr-only">必須</span>
          </span>
        ) : null}
      </legend>

      <div className="flex flex-col gap-2">
        {options.map((option) => {
          const optionId = `${groupId}-${option.value}`;
          const checked = value === option.value;
          return (
            <label
              key={option.value}
              htmlFor={optionId}
              className={cn(
                'flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors',
                checked
                  ? 'border-brand-500 bg-brand-50'
                  : 'border-slate-300 bg-white hover:bg-slate-50',
                option.disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                id={optionId}
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                disabled={option.disabled}
                onChange={() => {
                  onChange(option.value);
                }}
                className={cn(
                  'mt-0.5 size-5 shrink-0 accent-brand-600',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
                )}
              />
              <span className="min-w-0">
                <span className="block font-bold text-slate-900">{option.label}</span>
                {option.description !== undefined ? (
                  <span className="mt-0.5 block text-sm text-slate-600">{option.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>

      {hint !== undefined ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
      {error !== undefined ? <FieldError id={errorId}>{error}</FieldError> : null}
    </fieldset>
  );
}
