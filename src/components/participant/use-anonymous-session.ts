'use client';

import { useCallback } from 'react';
import { useRuntimeConfig } from '@/components/shared/runtime-config-provider';
import { getSupabaseBrowserClient } from '@/infrastructure/supabase/browser';

/**
 * 参加者用の匿名セッションを用意する。
 *
 * - 参加者へログインを求めない。Realtime の private channel と RLS のために
 *   匿名 Auth ユーザーだけを Cookie へ持たせる。
 * - すでにセッションがあれば何もしない（再訪時に同じ参加者として復元するため）。
 * - 失敗しても例外を投げない。参加登録 API 側でもセッションを確保できるため、
 *   ここで会場の参加を止めない。
 * - Secret Key は扱わない。RuntimeConfig の publishable key のみ。
 */
export function useEnsureAnonymousSession(): () => Promise<boolean> {
  const config = useRuntimeConfig();
  const { supabaseUrl, supabasePublishableKey } = config;

  return useCallback(async (): Promise<boolean> => {
    if (!supabaseUrl || !supabasePublishableKey) {
      return false;
    }
    try {
      const client = getSupabaseBrowserClient(supabaseUrl, supabasePublishableKey);
      const { data } = await client.auth.getSession();
      if (data.session) {
        return true;
      }
      const { error } = await client.auth.signInAnonymously();
      return !error;
    } catch {
      return false;
    }
  }, [supabaseUrl, supabasePublishableKey]);
}
