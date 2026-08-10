import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseSecretKey, supabaseUrl } from '@/lib/env/server-env';
import type { Database } from '@/types/database';

/**
 * RLS を迂回する管理クライアント。
 *
 * - Cloud Run のサーバー処理からのみ使用する。
 * - Client Component から絶対に import しない (`server-only` で保護)。
 * - 使用する箇所では必ずアプリ側で所有権・役割を検証してから呼ぶ。
 */
let cached: SupabaseClient<Database> | null = null;

export function createSupabaseAdminClient(): SupabaseClient<Database> {
  if (cached) {
    return cached;
  }
  cached = createClient<Database>(supabaseUrl(), supabaseSecretKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'X-Client-Info': 'smileq-live-server' },
    },
  });
  return cached;
}

/** テスト用にキャッシュを破棄する。 */
export function resetSupabaseAdminClient(): void {
  cached = null;
}
