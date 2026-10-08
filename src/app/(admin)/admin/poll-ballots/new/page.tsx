import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { PollBallotCreateForm } from '@/components/admin/poll-ballot-create-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '投票用紙を新規作成 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default function AdminPollBallotNewPage() {
  return (
    <>
      <AdminHeader current="poll-ballots" />
      <AdminPageBody
        title="投票用紙を新規作成"
        description="名前と選び方を決めると、続けて選択肢を入れられます。"
        breadcrumb={
          <Link href="/admin/poll-ballots" className="text-brand-700 font-bold hover:underline">
            ← 投票用紙一覧へ戻る
          </Link>
        }
        className="max-w-3xl"
      >
        <PollBallotCreateForm />
      </AdminPageBody>
    </>
  );
}
