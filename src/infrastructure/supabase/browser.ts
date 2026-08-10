'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * ブラウザ用 Supabase クライアント。
 *
 * URL と Publishable Key はビルド時に埋め込まず、RuntimeConfig から渡す。
 * Secret Key をここで扱わない。
 */
let cached: SupabaseClient<Database> | null = null;
let cachedUrl: string | null = null;

export function getSupabaseBrowserClient(
  url: string,
  publishableKey: string,
): SupabaseClient<Database> {
  if (cached && cachedUrl === url) {
    return cached;
  }
  cached = createBrowserClient<Database>(url, publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  cachedUrl = url;
  return cached;
}
