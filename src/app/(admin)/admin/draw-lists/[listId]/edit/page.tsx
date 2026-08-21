import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { DrawListEditor } from '@/components/admin/draw-list-editor';
import { FullScreenMessage } from '@/components/shared/FullScreenMessage';
import { uuidSchema } from '@/lib/validation/schemas';

/**
 * 抽選リストの編集画面。
 *
 * 骨組みだけ Server Component で組み、取得・保存・取り込みは Client Component が担当する。
 * Next.js 16 では params が Promise なので await して使う。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '抽選リストの編集 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default async function AdminDrawListEditPage({
  params,
}: {
  params: Promise<{ listId: string }>;
}) {
  const { listId } = await params;
  const parsed = uuidSchema.safeParse(listId);

  if (!parsed.success) {
    return (
      <FullScreenMessage
        title="抽選リストが見つかりません"
        description="URL が正しいかご確認ください。"
        tone="error"
        actions={
          <Link href="/admin/draw-lists" className="text-brand-700 font-bold hover:underline">
            抽選リスト一覧へ戻る
          </Link>
        }
      />
    );
  }

  return (
    <>
      <AdminHeader current="draw-lists" />
      <AdminPageBody
        title="抽選リストの編集"
        description="名前と演出の設定は自動で保存されます。行の追加・並べ替えは「行を保存する」で反映します。"
        breadcrumb={
          <Link href="/admin/draw-lists" className="text-brand-700 font-bold hover:underline">
            ← 抽選リスト一覧へ戻る
          </Link>
        }
      >
        <DrawListEditor listId={parsed.data} />
      </AdminPageBody>
    </>
  );
}
