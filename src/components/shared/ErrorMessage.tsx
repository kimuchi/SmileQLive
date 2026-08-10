'use client';

import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { isRetryableError, toUserErrorMessage } from '@/lib/client/error-text';

/**
 * 例外を利用者向けに表示する。
 *
 * - エラーコード・スタックトレース・SQL などの技術情報を出さない。
 * - 再試行できるものだけ「もう一度試す」を出す。
 */

export type ErrorMessageProps = {
  error: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
};

export function ErrorMessage({
  error,
  onRetry,
  retryLabel = 'もう一度試す',
  className,
}: ErrorMessageProps) {
  if (error === null || error === undefined || error === '') {
    return null;
  }

  const message = toUserErrorMessage(error);
  const showRetry = onRetry !== undefined && (isRetryableError(error) || typeof error === 'string');

  return (
    <Alert
      variant="error"
      className={className}
      actions={
        showRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}
