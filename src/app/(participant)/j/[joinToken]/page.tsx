import type { Metadata } from 'next';
import { JoinScreen } from '@/components/participant/JoinScreen';

/**
 * 二次元コードから直接開く参加ページ。
 *
 * - ここが唯一の参加導線。ルームコードを手入力する画面は作らない。
 * - 参加トークンはパスにしか存在させない。title・本文・解析へ複製しない。
 * - 登録に成功したら参加者画面へ replace 遷移し、URL からトークンを取り除く。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'クイズに参加 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default async function JoinPage({ params }: { params: Promise<{ joinToken: string }> }) {
  const { joinToken } = await params;
  return <JoinScreen joinToken={joinToken} />;
}
