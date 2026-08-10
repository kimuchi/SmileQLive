import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { RoomCreatePanel } from '@/components/admin/room-create-panel';
import { uuidSchema } from '@/lib/validation/schemas';

/** 公開済みクイズからルームを作成する。Next.js 16 では searchParams が Promise。 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ルーム作成 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default async function AdminRoomNewPage({
  searchParams,
}: {
  searchParams: Promise<{ quizId?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawQuizId = Array.isArray(params.quizId) ? params.quizId[0] : params.quizId;
  const parsed = uuidSchema.safeParse(rawQuizId);

  return (
    <>
      <AdminHeader current="rooms" />
      <AdminPageBody
        title="ルーム作成"
        description="開催ごとにルームを作ります。参加は二次元コードの読み取りだけで完了します。"
        breadcrumb={
          <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
            ← クイズ一覧へ戻る
          </Link>
        }
        className="max-w-4xl"
      >
        <RoomCreatePanel initialQuizId={parsed.success ? parsed.data : null} />
      </AdminPageBody>
    </>
  );
}
