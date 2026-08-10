import type { ReactNode } from 'react';

/**
 * 参加者画面の共通レイアウト。
 *
 * 約束:
 * - スマートフォンの縦持ち前提。iOS Safari のセーフエリア（ノッチ・ホームバー）を避ける。
 * - 効果音・振動は投影画面だけの責務。ここから音声モジュールを読み込まない。
 * - 参加トークンを画面へ出さない。URL 以外の場所へ複製しない。
 */
export default function ParticipantLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-dvh bg-slate-50 text-slate-900"
      style={{
        // Tailwind v4 にセーフエリア用ユーティリティが無いため env() を直接指定する。
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      {children}
    </div>
  );
}
