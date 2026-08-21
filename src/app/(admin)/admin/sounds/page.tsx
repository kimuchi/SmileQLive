import type { Metadata } from 'next';
import { AdminHeader } from '@/components/admin/admin-header';
import { AdminPageBody } from '@/components/admin/admin-page-body';
import { SoundSettingsPanel } from '@/components/admin/sound-settings-panel';

/** 効果音の差し替え。骨組みは Server Component、取得と操作だけ Client Component が担う。 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '効果音 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default function AdminSoundsPage() {
  return (
    <>
      <AdminHeader current="sounds" />
      <AdminPageBody
        title="効果音"
        description="会場で鳴る音をここで差し替えます。差し替えた音はすべてのクイズ・抽選会・ビンゴ・ルーレットで鳴ります。"
      >
        <SoundSettingsPanel />
      </AdminPageBody>
    </>
  );
}
