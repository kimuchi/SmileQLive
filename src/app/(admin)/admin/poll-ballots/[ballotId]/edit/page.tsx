import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { PollBallotEditor } from '@/components/admin/poll-ballot-editor';
import { FullScreenMessage } from '@/components/shared/FullScreenMessage';
import { uuidSchema } from '@/lib/validation/schemas';

/**
 * 投票用紙の編集画面。
 *
 * 骨組みだけ Server Component で組み、取得・保存は Client Component が担当する。
 * Next.js 16 では params が Promise なので await して使う。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '投票用紙の編集 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default async function AdminPollBallotEditPage({
  params,
}: {
  params: Promise<{ ballotId: string }>;
}) {
  const { ballotId } = await params;
  const parsed = uuidSchema.safeParse(ballotId);

  if (!parsed.success) {
    return (
      <FullScreenMessage
        title="投票用紙が見つかりません"
        description="URL が正しいかご確認ください。"
        tone="error"
        actions={
          <Link href="/admin/poll-ballots" className="text-brand-700 font-bold hover:underline">
            投票用紙一覧へ戻る
          </Link>
        }
      />
    );
  }

  return (
    <>
      <AdminHeader current="poll-ballots" />
      <AdminPageBody
        title="投票用紙の編集"
        description="名前・点数・発表の設定は自動で保存されます。区分と選択肢は「保存する」で反映します。"
        breadcrumb={
          <Link href="/admin/poll-ballots" className="text-brand-700 font-bold hover:underline">
            ← 投票用紙一覧へ戻る
          </Link>
        }
      >
        <PollBallotEditor ballotId={parsed.data} />
      </AdminPageBody>
    </>
  );
}
