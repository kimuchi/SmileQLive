import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/lib/auth/shared';

/**
 * 管理・司会画面のログインガード。
 *
 * 方針:
 * - middleware は **Edge ランタイム**で動く。firebase-admin は Node.js 専用なので
 *   **絶対に import しない**。ここではセッションクッキーの「有無」しか見ない。
 * - 本当の検証（署名・失効・profiles/{uid} の存在・許可ドメイン）は
 *   Route Handler / Server Component 側の requireHostUser() が行う。
 *   ここを通過しても権限が無ければ最終的に 403 で弾かれる（多層防御の外側）。
 * - 参加者は匿名セッションで利用するため、参加者画面をリダイレクトしない。
 * - Firebase の公開設定が未構成なら何もせず素通しする
 *   （ビルド時・設定不足時にクラッシュさせない。設定不足は /api/diagnostics で検知する）。
 * - 参加トークンを含む URL をここでログ出力しない。
 */

const LOGIN_PATH = '/admin/login';

/**
 * ログイン不要で到達できる管理系パス。
 *
 * `/admin/sounds` は `/sounds` へ転送するだけの入れ物。
 * 効果音の設定はログイン無しで開ける場所へ移したので、
 * ここを塞ぐと古いブックマークがログイン画面で行き止まりになる。
 */
const PUBLIC_ADMIN_PATHS = ['/admin/login', '/admin/auth', '/admin/sounds'];

function requiresHostSession(pathname: string): boolean {
  if (PUBLIC_ADMIN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return false;
  }
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/host' ||
    pathname.startsWith('/host/')
  );
}

/**
 * Firebase の公開設定が揃っているか。
 * プロジェクト ID が 1 つも読めないときは「未構成」とみなしてガードを掛けない。
 */
function isFirebaseConfigured(): boolean {
  const projectId =
    process.env.FIREBASE_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCLOUD_PROJECT;
  return Boolean(projectId && projectId.trim().length > 0);
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (!requiresHostSession(pathname)) {
    return NextResponse.next();
  }

  if (!isFirebaseConfigured()) {
    // 設定不足の環境ではガードを掛けず、画面側の「構成エラー」表示に任せる。
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sessionCookie && sessionCookie.length > 0) {
    return NextResponse.next();
  }

  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = LOGIN_PATH;
  redirectUrl.search = '';
  // 参加トークンを含まない管理系パスのみを戻り先として渡す。
  redirectUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(redirectUrl);
}

export const config = {
  matcher: [
    /*
     * 管理・司会画面だけを対象にする。
     * 参加者画面・投影画面・API はここを通さない（不要なオーバーヘッドと誤リダイレクトを避ける）。
     */
    '/admin',
    '/admin/:path*',
    '/host',
    '/host/:path*',
  ],
};
