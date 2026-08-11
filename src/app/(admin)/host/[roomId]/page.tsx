import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { HostConsole, type HostQuestionOutline } from '@/components/admin/host-console';
import { FullScreenMessage } from '@/components/shared/FullScreenMessage';
import { parseQuizSnapshot } from '@/application/services/quiz-snapshot-codec';
import { requireRoomOwner } from '@/lib/auth/session';
import { AppError } from '@/lib/errors/app-error';
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
    return (
      <HostUnavailable
        title="ルームの URL が正しくありません"
        description="クイズ一覧からルームを作成し直すか、司会用のリンクを開き直してください。"
      />
    );
  }

  let quizTitle = '';
  let outline: HostQuestionOutline[] = [];

  try {
    const { room } = await requireRoomOwner(parsed.data);
    const snapshot = parseQuizSnapshot(room.quizSnapshot);
    quizTitle = snapshot.title;
    outline = [...snapshot.questions]
      .sort((a, b) => a.position - b.position)
      .map((question) => ({
        id: question.id,
        position: question.position,
        type: question.type,
        summary: summarize(question.text, question.image !== null),
      }));
  } catch (error) {
    // この画面は司会者だけが開ける（未ログインは手前で弾かれる）。
    // 相手が運営担当者である以上、原因を伏せると自分で直せない。
    // 「見つからない」と「自分のルームではない」は対処が違うので分けて伝える。
    const code = error instanceof AppError ? error.code : '';

    if (code === 'ROOM_NOT_FOUND') {
      return (
        <HostUnavailable
          title="ルームが見つかりません"
          description="削除されたか、URL が違う可能性があります。クイズ一覧からルームを作成し直してください。"
        />
      );
    }
    if (code === 'FORBIDDEN') {
      return (
        <HostUnavailable
          title="このルームの司会者ではありません"
          description="ルームを操作できるのは作成した本人だけです。共有されたクイズでも、ルームは各自で作成してください。"
        />
      );
    }
    return (
      <HostUnavailable
        title="このルームを開けません"
        description="ルームが見つからないか、司会の権限がありません。URL をご確認ください。"
      />
    );
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

function HostUnavailable({ title, description }: { title: string; description: string }) {
  return (
    <FullScreenMessage
      title={title}
      description={description}
      tone="error"
      actions={
        <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
          クイズ一覧へ戻る
        </Link>
      }
    />
  );
}
