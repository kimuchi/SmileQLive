import type { Metadata } from 'next';
import { PlayScreen } from '@/components/participant/PlayScreen';

/**
 * 参加者の進行画面。
 *
 * URL に参加トークンを含めない（/j/<token> から replace 遷移してくる）。
 * 表示内容はすべて Snapshot API から取得し、Realtime は取り直しの合図としてだけ使う。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'クイズ | SmileQ Live',
  robots: { index: false, follow: false },
};

export default async function PlayPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <PlayScreen roomId={roomId} />;
}
