import type { ReactNode } from 'react';

/**
 * 管理・司会画面の共通枠。
 *
 * - 効果音モジュールは読み込まない（音は投影画面だけの責務）。
 * - 実行時環境変数を読むため静的化しない。
 */
export const dynamic = 'force-dynamic';

export default function AdminGroupLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-slate-50 text-slate-900">{children}</div>;
}
