import type { Metadata, Viewport } from 'next';
import { RuntimeConfigProvider } from '@/components/shared/runtime-config-provider';
import {
  allowedAuthDomains,
  appBaseUrl,
  firebaseApiKey,
  firebaseAppId,
  firebaseAuthDomain,
  firebaseProjectId,
  firebaseStorageBucket,
  firestoreDatabaseId,
} from '@/lib/env/server-env';
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

/**
 * ブラウザへ渡す実行時設定を組み立てる。
 *
 * - **秘密情報を含めない。** Firebase の apiKey は公開前提の識別子であり秘密鍵ではない
 *   （docs/FIRESTORE_MODEL.md §6）。サーバー用の秘密情報は Firebase 版には存在しない。
 * - 設定が不足していても描画自体は止めず、空文字で渡す。
 *   画面側が `useIsConfigured()` で構成エラーを明示する
 *   （起動直後の最初の要求で曖昧に失敗させない、という仕様 §39.3 の要件）。
 */
function buildRuntimeConfig() {
  const read = (getter: () => string): string => {
    try {
      return getter();
    } catch {
      return '';
    }
  };

  return {
    firebaseApiKey: read(firebaseApiKey),
    firebaseAuthDomain: read(firebaseAuthDomain),
    firebaseProjectId: read(firebaseProjectId),
    firebaseStorageBucket: read(firebaseStorageBucket),
    firebaseAppId: firebaseAppId(),
    firestoreDatabaseId: firestoreDatabaseId(),
    appBaseUrl: appBaseUrl(),
    allowedAuthDomains: allowedAuthDomains(),
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY ?? null,
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const runtimeConfig = buildRuntimeConfig();

  return (
    <html lang="ja">
      <body className="bg-slate-50 text-slate-900 antialiased">
        <RuntimeConfigProvider value={runtimeConfig}>{children}</RuntimeConfigProvider>
      </body>
    </html>
  );
}
