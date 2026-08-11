import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { RoomListPanel } from '@/components/admin/room-list-panel';

/**
 * ルーム一覧。
 * 司会画面へ戻るための導線。ルーム作成直後の画面を離れても進行へ復帰できる。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ルーム一覧 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default function AdminRoomsPage() {
  return (
    <>
      <AdminHeader current="rooms" />
      <AdminPageBody
        title="ルーム一覧"
        description="開催ごとに作成したルームです。司会画面を開き直せます。"
        actions={
          <Link
            href="/admin/rooms/new"
            className="bg-brand-600 hover:bg-brand-700 focus-visible:outline-brand-600 inline-flex min-h-12 items-center rounded-xl px-5 text-base font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            ルームを作成
          </Link>
        }
      >
        <RoomListPanel />
      </AdminPageBody>
    </>
  );
}
