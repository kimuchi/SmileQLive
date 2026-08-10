'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/shared/Button';

/**
 * URL をクリップボードへコピーするボタン。
 *
 * 参加URLには参加トークンが含まれる。
 * ここではクリップボードへ書き込むだけで、ログ・解析・Referer へは一切渡さない。
 */

const RESET_DELAY_MS = 2500;

export type CopyButtonProps = {
  value: string;
  label?: string;
  copiedLabel?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  className?: string;
};

export function CopyButton({
  value,
  label = 'URLをコピー',
  copiedLabel = 'コピーしました',
  size = 'sm',
  variant = 'secondary',
  className,
}: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // 安全なコンテキスト外や権限拒否のとき。手動コピーを促す。
      setState('failed');
    }
    timerRef.current = setTimeout(() => {
      setState('idle');
      timerRef.current = null;
    }, RESET_DELAY_MS);
  }, [value]);

  return (
    <span className={className}>
      <Button variant={variant} size={size} onClick={handleCopy}>
        {state === 'copied' ? copiedLabel : label}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'copied' ? 'コピーしました' : ''}
        {state === 'failed' ? 'コピーできませんでした' : ''}
      </span>
      {state === 'failed' ? (
        <span className="ml-2 text-xs font-bold text-red-700">
          コピーできませんでした。URLを選択して手動でコピーしてください
        </span>
      ) : null}
    </span>
  );
}
