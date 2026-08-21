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
  aside,
  children,
  className,
  backgroundUrl = null,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  /**
   * 右下へ置く小さな添え物（参加用の二次元コードなど）。
   *
   * **重ねずに場所を取る。** 問題文や選択肢の上へ半透明で重ねると、
   * 会場の後方から文字が読めなくなる。その分だけ本体を狭くする。
   */
  aside?: ReactNode;
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
          {aside ? (
            <div
              className="flex min-h-0 flex-1 flex-row items-stretch"
              style={{ gap: stageSize(28) }}
            >
              <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center overflow-hidden">
                {children}
              </div>
              <div className="flex shrink-0 flex-col justify-end">{aside}</div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden">
              {children}
            </div>
          )}
          {footer ?? null}
        </div>
      </div>
    </main>
  );
}
