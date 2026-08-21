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
  backgroundUrl = null,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * ステージ全体の背景に敷く画像。
   *
   * 抽選会・ビンゴで会場の雰囲気に合わせた背景を使うためのもの。
   * 文字が読めなくならないよう、上から暗い膜を重ねる。
   */
  backgroundUrl?: string | null;
}) {
  return (
    <main className="stage-root flex min-h-dvh w-full items-center justify-center overflow-hidden">
      <div
        className="stage-scale relative aspect-video w-full"
        // 高さが足りないときは高さ基準で幅を決め、16:9 のまま収める。
        style={{ width: 'min(100vw, calc(100dvh * 16 / 9))' }}
      >
        {backgroundUrl ? (
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${JSON.stringify(backgroundUrl)})` }}
          >
            {/* 背景の明るさに関係なく、白い文字が読める濃さまで落とす。 */}
            <div className="absolute inset-0 bg-black/55" />
          </div>
        ) : null}
        <div
          className={cn('relative flex h-full w-full flex-col', className)}
          style={{ padding: stageSize(56), gap: stageSize(24) }}
        >
          {header ?? null}
          {/*
            overflow-hidden は最後の砦。中身が高さを超えたとき、
            justify-center のままだと上下へはみ出して見出しや進捗表示へ重なる。
            各ステージ側で縮む要素（画像など）を用意したうえで、
            それでも収まらない場合はここで切る（重ねない）。
          */}
          <div className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden">
            {children}
          </div>
          {footer ?? null}
        </div>
      </div>
    </main>
  );
}
