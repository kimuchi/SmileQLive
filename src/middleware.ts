import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Auth Cookie の更新と、管理・司会画面のログインガード。
 *
 * 方針:
 * - 参加者は匿名セッションで利用するため、参加者画面をリダイレクトしない。
 * - SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY が未設定なら何もせず素通しする
 *   （ビルド時・設定不足時にクラッシュさせない。設定不足は /api/diagnostics で検知する）。
 * - 参加トークンを含む URL をここでログ出力しない。
 * - Secret Key は絶対に参照しない（publishable key のみ）。
 */

const LOGIN_PATH = '/admin/login';

/** ログイン不要で到達できる管理系パス。 */
const PUBLIC_ADMIN_PATHS = ['/admin/login', '/admin/auth'];

function requiresHostSession(pathname: string): boolean {
  if (PUBLIC_ADMIN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return false;
  }
  return pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/host' || pathname.startsWith('/host/');
}

export async function middleware(request: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() を呼ぶことでセッションが更新され、Cookie が書き戻される。
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  if (requiresHostSession(pathname)) {
    // 匿名セッション（参加者）では管理・司会画面へ入れない。
    if (!user || user.is_anonymous === true) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = LOGIN_PATH;
      redirectUrl.search = '';
      // 参加トークンを含まない管理系パスのみを戻り先として渡す。
      redirectUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(redirectUrl);
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * 静的アセットと起動プローブ (/api/health) を除いたすべてのパス。
     * 画像・フォント・マップファイルも除外する。
     */
    '/((?!_next/static|_next/image|api/health|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|mjs|map|txt|woff|woff2|ttf|otf)$).*)',
  ],
};
