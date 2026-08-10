import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { QuizListPanel } from '@/components/admin/quiz-list-panel';

/** クイズ一覧。骨組みは Server Component、一覧の取得と操作だけ Client Component が担う。 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'クイズ一覧 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default function AdminQuizzesPage() {
  return (
    <>
      <AdminHeader current="quizzes" />
      <AdminPageBody
        title="クイズ一覧"
        description="問題の編集・複製と、公開済みクイズからのルーム作成を行います。"
        actions={
          <Link
            href="/admin/quizzes/new"
            className="bg-brand-600 hover:bg-brand-700 focus-visible:outline-brand-600 inline-flex min-h-12 items-center rounded-xl px-5 text-base font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            クイズを新規作成
          </Link>
        }
      >
        <QuizListPanel />
      </AdminPageBody>
    </>
  );
}
