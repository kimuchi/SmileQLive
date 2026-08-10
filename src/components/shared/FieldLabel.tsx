import type { ReactNode } from 'react';
import { cn } from '@/lib/client/cn';

/**
 * 入力欄のラベルと、補足・エラーの表示。
 * aria-describedby で結び付けるため、id 生成は各入力コンポーネント側で行う。
 */

export type FieldLabelProps = {
  htmlFor: string;
  children: ReactNode;
  required?: boolean;
  className?: string;
};

export function FieldLabel({ htmlFor, children, required = false, className }: FieldLabelProps) {
  return (
    <label htmlFor={htmlFor} className={cn('block text-sm font-bold text-slate-800', className)}>
      {children}
      {required ? (
        <span className="ml-1 text-red-600">
          <span aria-hidden="true">*</span>
          <span className="sr-only">必須</span>
        </span>
      ) : null}
    </label>
  );
}

export type FieldHintProps = {
  id: string;
  children: ReactNode;
  className?: string;
};

export function FieldHint({ id, children, className }: FieldHintProps) {
  return (
    <p id={id} className={cn('text-xs text-slate-600', className)}>
      {children}
    </p>
  );
}

export type FieldErrorProps = {
  id: string;
  children: ReactNode;
  className?: string;
};

export function FieldError({ id, children, className }: FieldErrorProps) {
  return (
    <p id={id} role="alert" className={cn('text-sm font-bold text-red-700', className)}>
      {children}
    </p>
  );
}
