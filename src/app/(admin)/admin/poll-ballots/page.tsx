import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { PollBallotPanel } from '@/components/admin/poll-ballot-panel';

/** 投票用紙一覧。骨組みは Server Component、一覧の取得と操作だけ Client Component が担う。 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '投票用紙一覧 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default function AdminPollBallotsPage() {
  return (
    <>
      <AdminHeader current="poll-ballots" />
      <AdminPageBody
        title="投票用紙一覧"
        description="会場の全員に投票してもらう内容をここで用意します。出し物コンテストや、いちばん良かった発表を選ぶ場面で使います。"
        actions={
          <Link
            href="/admin/poll-ballots/new"
            className="bg-brand-600 hover:bg-brand-700 focus-visible:outline-brand-600 inline-flex min-h-12 items-center rounded-xl px-5 text-base font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            投票用紙を新規作成
          </Link>
        }
      >
        <PollBallotPanel />
      </AdminPageBody>
    </>
  );
}
