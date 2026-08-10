import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { QuizEditor } from '@/components/admin/quiz-editor';
import { FullScreenMessage } from '@/components/shared/FullScreenMessage';
import { uuidSchema } from '@/lib/validation/schemas';

/**
 * 問題編集画面。
 *
 * 骨組みだけ Server Component で組み、取得・自動保存・公開は Client Component が担当する。
 * Next.js 16 では params が Promise なので await して使う。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '問題の編集 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default async function AdminQuizEditPage({
  params,
}: {
  params: Promise<{ quizId: string }>;
}) {
  const { quizId } = await params;
  const parsed = uuidSchema.safeParse(quizId);

  if (!parsed.success) {
    return (
      <FullScreenMessage
        title="クイズが見つかりません"
        description="URL が正しいかご確認ください。"
        tone="error"
        actions={
          <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
            クイズ一覧へ戻る
          </Link>
        }
      />
    );
  }

  return (
    <>
      <AdminHeader current="quizzes" />
      <AdminPageBody
        title="問題の編集"
        description="入力は自動で保存されます。公開すると、このクイズからルームを作成できます。"
        breadcrumb={
          <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
            ← クイズ一覧へ戻る
          </Link>
        }
      >
        <QuizEditor quizId={parsed.data} />
      </AdminPageBody>
    </>
  );
}
