import type { Metadata } from 'next';
import { PresentScreen } from '@/components/presentation/PresentScreen';

/**
 * 会場投影画面。
 *
 * - 表示内容はすべて staff Snapshot API から取得する。ここで進行は変更しない。
 * - URL に含まれるのはルーム ID だけ。参加トークン・投影トークンを URL へ残さない。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '投影画面 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default async function PresentPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <PresentScreen roomId={roomId} />;
}
