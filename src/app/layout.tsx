import type { Metadata, Viewport } from 'next';
import { RuntimeConfigProvider } from '@/components/shared/runtime-config-provider';
import { appBaseUrl } from '@/lib/env/server-env';
import './globals.css';

/**
 * Cloud Run の実行時環境変数を読むため、ビルド時の値へ固定しない。
 * 音声モジュールは共通レイアウトで初期化しない（投影画面からのみ動的 import する）。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'SmileQ Live',
  description: '会場イベント向けリアルタイムクイズシステム',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#122457',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const runtimeConfig = {
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
    appBaseUrl: appBaseUrl(),
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY ?? null,
  };

  return (
    <html lang="ja">
      <body className="bg-slate-50 text-slate-900 antialiased">
        <RuntimeConfigProvider value={runtimeConfig}>{children}</RuntimeConfigProvider>
      </body>
    </html>
  );
}
