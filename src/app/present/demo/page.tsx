import type { Metadata } from 'next';
import { PresentDemo } from '@/components/presentation/PresentDemo';
import { isDemoMode, type DemoMode } from '@/domain/draw/demo-draw';

/**
 * 投影画面のデモ。
 *
 * **ログインもルームも要らない。** URL をそのまま人へ渡せる。
 * 抽選会・ビンゴ・ルーレットを、この画面だけで回して見せられる。
 *
 * 引くのはブラウザの中だけで、サーバーへは何も送らないし記録も残らない。
 * 本番の抽選（サーバーが引いて記録する）とは経路が別になっている。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '投影デモ | SmileQ Live',
  robots: { index: false, follow: false },
};

export default async function PresentDemoPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  // /present/demo?mode=bingo のように、見せたい催しから開けるようにする。
  const initialMode: DemoMode = isDemoMode(mode) ? mode : 'lottery';
  return <PresentDemo initialMode={initialMode} />;
}
