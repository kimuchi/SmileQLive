import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { QuizCreateForm } from '@/components/admin/quiz-create-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'クイズを新規作成 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default function AdminQuizNewPage() {
  return (
    <>
      <AdminHeader current="quizzes" />
      <AdminPageBody
        title="クイズを新規作成"
        description="タイトルを決めると、続けて問題を追加できます。"
        breadcrumb={
          <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
            ← クイズ一覧へ戻る
          </Link>
        }
        className="max-w-3xl"
      >
        <QuizCreateForm />
      </AdminPageBody>
    </>
  );
}
