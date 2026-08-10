import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { supabasePublishableKey, supabaseUrl } from '@/lib/env/server-env';
import type { Database } from '@/types/database';

/**
 * リクエストスコープの Supabase クライアント（Auth Cookie 連携あり）。
 * RLS が適用されるため、通常の読み書きはこのクライアントを使う。
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, {
              ...options,
              httpOnly: true,
              sameSite: 'lax',
              secure: process.env.NODE_ENV === 'production',
            });
          }
        } catch {
          // Server Component から呼ばれた場合は書き込みできない。middleware 側で更新される。
        }
      },
    },
  });
}

/** 現在の Auth ユーザー。未認証なら null。 */
export async function getAuthUser() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return null;
  }
  return data.user;
}
