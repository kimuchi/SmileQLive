'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/client/cn';
import { stageSize } from '@/components/presentation/stage-theme';

/**
 * 投影ステージの外枠。
 *
 * - 16:9 を必ず保つ。投影機の解像度が変わっても構図が崩れないようにする。
 * - 画面外へはみ出さないよう、幅は「ビューポート幅」と「高さから逆算した幅」の小さい方にする。
 * - container-type: inline-size (.stage-scale) を与え、内部の文字サイズを幅に比例させる。
 * - 上下左右に余白を取り、投影機のオーバースキャンで端が切れても情報が欠けないようにする。
 */
export function StageFrame({
  header,
  footer,
  children,
  className,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <main className="stage-root flex min-h-dvh w-full items-center justify-center overflow-hidden">
      <div
        className="stage-scale relative aspect-video w-full"
        // 高さが足りないときは高さ基準で幅を決め、16:9 のまま収める。
        style={{ width: 'min(100vw, calc(100dvh * 16 / 9))' }}
      >
        <div
          className={cn('flex h-full w-full flex-col', className)}
          style={{ padding: stageSize(56), gap: stageSize(24) }}
        >
          {header ?? null}
          <div className="flex min-h-0 flex-1 flex-col justify-center">{children}</div>
          {footer ?? null}
        </div>
      </div>
    </main>
  );
}
