import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { RoomCreatePanel } from '@/components/admin/room-create-panel';
import { isRoomMode, type RoomMode } from '@/domain/room/room-mode';
import { uuidSchema } from '@/lib/validation/schemas';

/** 公開済みクイズ・抽選リストからルームを作成する。Next.js 16 では searchParams が Promise。 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ルーム作成 | SmileQ Live',
  robots: { index: false, follow: false },
};

/** 同じ名前で複数回渡されたときは先頭だけを見る。 */
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminRoomNewPage({
  searchParams,
}: {
  searchParams: Promise<{ quizId?: string | string[]; mode?: string | string[] }>;
}) {
  const params = await searchParams;
  const parsed = uuidSchema.safeParse(firstParam(params.quizId));
  const rawMode = firstParam(params.mode);
  // 抽選リスト画面から「このモードで作る」と指定して来たときだけ初期モードを変える。
  const initialMode: RoomMode = rawMode !== undefined && isRoomMode(rawMode) ? rawMode : 'quiz';

  return (
    <>
      <AdminHeader current="rooms" />
      <AdminPageBody
        title="ルーム作成"
        description="開催ごとにルームを作ります。まずクイズ・抽選会・ビンゴ・ルーレットのどれを開くか選んでください。"
        breadcrumb={
          // クイズを指定して来た人はクイズ一覧へ、それ以外はルーム一覧へ戻す（来た場所へ返す）。
          parsed.success ? (
            <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
              ← クイズ一覧へ戻る
            </Link>
          ) : (
            <Link href="/admin/rooms" className="text-brand-700 font-bold hover:underline">
              ← ルーム一覧へ戻る
            </Link>
          )
        }
        className="max-w-4xl"
      >
        <RoomCreatePanel
          initialQuizId={parsed.success ? parsed.data : null}
          initialMode={initialMode}
        />
      </AdminPageBody>
    </>
  );
}
