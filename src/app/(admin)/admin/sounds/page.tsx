import { redirect } from 'next/navigation';

/**
 * 旧: 効果音の設定（`/admin/sounds`）。
 *
 * ログイン無しで開ける `/sounds` へ移した。
 * 会場で「音を差し替えたいだけ」の人にログインを求めないため。
 * 既に配ってある URL やブックマークが死なないよう、ここは転送だけ残す。
 */
export default function AdminSoundsRedirectPage(): never {
  redirect('/sounds');
}
