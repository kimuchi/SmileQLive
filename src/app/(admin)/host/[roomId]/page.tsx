import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { HostConsole, type HostQuestionOutline } from '@/components/admin/host-console';
import { FullScreenMessage } from '@/components/shared/FullScreenMessage';
import { parseQuizSnapshot } from '@/application/services/quiz-snapshot-codec';
import {
  ROOM_MODE_DESCRIPTIONS,
  isDrawMode,
  roomModeOf,
  type RoomMode,
} from '@/domain/room/room-mode';
import { logger } from '@/infrastructure/logging/logger';
import { requireRoomOwner } from '@/lib/auth/session';
import { uuidSchema } from '@/lib/validation/schemas';

/**
 * 司会進行画面。
 *
 * 進行に必要な「問題の並び（ID と番号）」だけをサーバー側で取り出して渡す。
 * ルームのスナップショットには正解情報が含まれるため、
 * ここでは ID・番号・回答形式・問題文の要約だけを取り出し、正解はクライアントへ送らない。
 *
 * 抽選会・ビンゴのルームには問題が無い（0 問のクイズが入っている）。
 * 引くものは Snapshot の draw で届くため、ここでは案内文と戻り先だけをモードに合わせる。
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
  // 保存されていないルームはクイズとして扱う（モードが増える前に作られたもの）。
  let mode: RoomMode = 'quiz';

  try {
    const { room } = await requireRoomOwner(parsed.data);
    mode = roomModeOf(room.mode);
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
    //
    // instanceof は使わない。Server Component と Route Handler で
    // 同じモジュールが別々に読み込まれることがあり、クラスの同一性が保証されない。
    // クラスではなく構造（code フィールド）で判定する。
    const code = errorCode(error);

    // 画面の表示だけでは追えないことがあるため、サーバー側にも残す。
    // トークン・メールアドレスは出さない（roomId と分類だけ）。
    logger.warn('host.open_failed', {
      roomId: parsed.data,
      code: code || errorName(error),
      message: error instanceof Error ? error.message : String(error),
    });

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
    if (code === 'UNAUTHENTICATED') {
      return (
        <HostUnavailable
          title="ログインの有効期限が切れています"
          description="もう一度ログインしてから、ルーム一覧を開き直してください。"
          code={code}
        />
      );
    }
    return (
      <HostUnavailable
        title="このルームを開けません"
        description="ルームが見つからないか、司会の権限がありません。URL をご確認ください。"
        code={code || errorName(error)}
      />
    );
  }

  return (
    <>
      <AdminHeader />
      <AdminPageBody
        title="司会画面"
        description={
          isDrawMode(mode)
            ? ROOM_MODE_DESCRIPTIONS[mode]
            : '参加は二次元コードの読み取りだけで完了します。'
        }
        breadcrumb={
          // 抽選会・ビンゴはクイズから開かない。戻り先もルーム一覧にする。
          isDrawMode(mode) ? (
            <Link href="/admin/rooms" className="text-brand-700 font-bold hover:underline">
              ← ルーム一覧へ戻る
            </Link>
          ) : (
            <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
              ← クイズ一覧へ戻る
            </Link>
          )
        }
      >
        <HostConsole roomId={parsed.data} quizTitle={quizTitle} outline={outline} />
      </AdminPageBody>
    </>
  );
}

/** 例外から AppError のコードを構造で取り出す（クラスの同一性に依存しない）。 */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function HostUnavailable({
  title,
  description,
  code,
}: {
  title: string;
  description: string;
  /** 運営担当者が原因を特定するための手掛かり。伏せると問い合わせても分からない。 */
  code?: string;
}) {
  return (
    <FullScreenMessage
      title={title}
      description={description}
      tone="error"
      actions={
        <div className="flex flex-col items-center gap-3">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link href="/admin/rooms" className="text-brand-700 font-bold hover:underline">
              ルーム一覧へ
            </Link>
            <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
              クイズ一覧へ戻る
            </Link>
          </div>
          {code ? <p className="font-mono text-xs text-slate-500">詳細コード: {code}</p> : null}
        </div>
      }
    />
  );
}
