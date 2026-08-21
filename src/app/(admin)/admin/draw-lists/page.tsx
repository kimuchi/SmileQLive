import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { DrawListPanel } from '@/components/admin/draw-list-panel';

/** 抽選リスト一覧。骨組みは Server Component、一覧の取得と操作だけ Client Component が担う。 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '抽選リスト一覧 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default function AdminDrawListsPage() {
  return (
    <>
      <AdminHeader current="draw-lists" />
      <AdminPageBody
        title="抽選リスト一覧"
        description="抽選会・ビンゴで引くものをここで用意します。表計算ソフトの名簿を貼り付けて取り込めます。"
        actions={
          <Link
            href="/admin/draw-lists/new"
            className="bg-brand-600 hover:bg-brand-700 focus-visible:outline-brand-600 inline-flex min-h-12 items-center rounded-xl px-5 text-base font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            抽選リストを新規作成
          </Link>
        }
      >
        <DrawListPanel />
      </AdminPageBody>
    </>
  );
}
