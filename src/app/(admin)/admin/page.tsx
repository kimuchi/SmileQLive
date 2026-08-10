import { redirect } from 'next/navigation';

/** /admin へ来たときの入口。管理画面の起点であるクイズ一覧へ送る。 */
export const dynamic = 'force-dynamic';

export default function AdminIndexPage(): never {
  redirect('/admin/quizzes');
}
