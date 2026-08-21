import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { DrawListCreateForm } from '@/components/admin/draw-list-create-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '抽選リストを新規作成 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default function AdminDrawListNewPage() {
  return (
    <>
      <AdminHeader current="draw-lists" />
      <AdminPageBody
        title="抽選リストを新規作成"
        description="名前と種類を決めると、続けて中身を入れられます。"
        breadcrumb={
          <Link href="/admin/draw-lists" className="text-brand-700 font-bold hover:underline">
            ← 抽選リスト一覧へ戻る
          </Link>
        }
        className="max-w-3xl"
      >
        <DrawListCreateForm />
      </AdminPageBody>
    </>
  );
}
