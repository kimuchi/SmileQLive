import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { HostConsole, type HostQuestionOutline } from '@/components/admin/host-console';
import { FullScreenMessage } from '@/components/shared/FullScreenMessage';
import { parseQuizSnapshot } from '@/application/services/quiz-snapshot-codec';
import { requireRoomOwner } from '@/lib/auth/session';
import { uuidSchema } from '@/lib/validation/schemas';

/**
 * 司会進行画面。
 *
 * 進行に必要な「問題の並び（ID と番号）」だけをサーバー側で取り出して渡す。
 * ルームのスナップショットには正解情報が含まれるため、
 * ここでは ID・番号・回答形式・問題文の要約だけを取り出し、正解はクライアントへ送らない。
 *
 * Next.js 16 では params が Promise なので await して使う。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: '司会画面 | SmileQ Live',
  robots: { index: false, follow: false },
};

const SUMMARY_MAX_LENGTH = 60;

function summarize(text: string | null, hasImage: boolean): string {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) {
    return hasImage ? '（画像の問題）' : '（未入力）';
  }
  return trimmed.length > SUMMARY_MAX_LENGTH ? `${trimmed.slice(0, SUMMARY_MAX_LENGTH)}…` : trimmed;
}

export default async function HostRoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const parsed = uuidSchema.safeParse(roomId);

  if (!parsed.success) {
    return <HostUnavailable />;
  }

  let quizTitle = '';
  let outline: HostQuestionOutline[] = [];

  try {
    const { room } = await requireRoomOwner(parsed.data);
    const snapshot = parseQuizSnapshot(room.quiz_snapshot);
    quizTitle = snapshot.title;
    outline = [...snapshot.questions]
      .sort((a, b) => a.position - b.position)
      .map((question) => ({
        id: question.id,
        position: question.position,
        type: question.type,
        summary: summarize(question.text, question.image !== null),
      }));
  } catch {
    // 権限が無い・ルームが無い場合は理由を明かさず、共通の案内だけを出す。
    return <HostUnavailable />;
  }

  return (
    <>
      <AdminHeader />
      <AdminPageBody
        title="司会画面"
        description="参加は二次元コードの読み取りだけで完了します。"
        breadcrumb={
          <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
            ← クイズ一覧へ戻る
          </Link>
        }
      >
        <HostConsole roomId={parsed.data} quizTitle={quizTitle} outline={outline} />
      </AdminPageBody>
    </>
  );
}

function HostUnavailable() {
  return (
    <FullScreenMessage
      title="このルームを開けません"
      description="ルームが見つからないか、司会の権限がありません。URL をご確認ください。"
      tone="error"
      actions={
        <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
          クイズ一覧へ戻る
        </Link>
      }
    />
  );
}
