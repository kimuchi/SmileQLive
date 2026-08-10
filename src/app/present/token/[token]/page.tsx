import type { Metadata } from 'next';
import { PresentTokenExchange } from '@/components/presentation/PresentTokenExchange';

/**
 * 別端末で投影を始めるための引き換えページ。
 *
 * - 投影用トークンはパスにしか存在させない。title・本文・解析へ複製しない。
 * - 引き換え後は /present/[roomId] へ replace 遷移し、URL からトークンを取り除く。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '投影画面の準備 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default async function PresentTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PresentTokenExchange token={token} />;
}
