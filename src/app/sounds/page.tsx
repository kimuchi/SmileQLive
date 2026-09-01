import type { Metadata } from 'next';
import Link from 'next/link';
import { SoundSettingsPanel } from '@/components/admin/sound-settings-panel';

/**
 * 効果音の差し替え。
 *
 * **ログインを求めない。**
 * 会場では投影担当・司会・音響が別の人で、別の端末で画面を開く。
 * 「音を差し替えたいだけ」なのにログインを求めると当日その場で直せない。
 * ここを `/admin` の下から出しているのはそのため（`/admin/**` はログインで塞いでいる）。
 *
 * 差し替えた音は**すべての催しで鳴る**。設定はシステム全体で 1 つ。
 * 裏を返すと **URL を知っている人は誰でも差し替えられる**ので、
 * 外へ公開する場合は Cloud Run 側で入口を絞ること（docs/SOUNDS.md）。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '効果音 | SmileQ Live',
  robots: { index: false, follow: false },
};

export default function SoundsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-6">
        <p className="text-brand-700 text-sm font-bold tracking-wide">SmileQ Live</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">効果音</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          会場で鳴る音をここで差し替えます。差し替えた音は
          <strong className="font-bold">
            すべてのクイズ・抽選会・ビンゴ・ルーレット・投票で鳴ります
          </strong>
          。デプロイし直す必要はありません。
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          この画面はログイン無しで開けます。URL を知っている人は誰でも差し替えられるので、
          社外へ公開している場合はご注意ください。
        </p>
      </header>

      <SoundSettingsPanel />

      <p className="mt-8 text-sm">
        <Link href="/roulette" className="text-brand-700 font-bold underline">
          ルーレットへ
        </Link>
      </p>
    </main>
  );
}
