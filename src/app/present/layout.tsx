import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

/**
 * 会場投影画面の共通レイアウト。
 *
 * - 暗い背景を土台にし、投影機で明るくなりすぎないようにする。
 * - 効果音を扱ってよいのはこの配下だけ。参加者画面・共通レイアウトへ音声を持ち込まない。
 * - 投影中に画面が消えると進行が止まるため、検索対象にもしない（noindex）。
 */
export const metadata: Metadata = {
  title: '投影画面 | SmileQ Live',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#070c1c',
};

export default function PresentLayout({ children }: { children: ReactNode }) {
  return <div className="bg-stage-950 min-h-dvh text-white">{children}</div>;
}
