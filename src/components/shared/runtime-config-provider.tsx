'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from '@/infrastructure/supabase/browser';
import type { Database } from '@/types/database';

/**
 * 実行時公開設定。
 *
 * ビルド時に NEXT_PUBLIC_* として埋め込まず、Server Component がリクエスト時に読んだ値を渡す。
 * これにより同一コンテナイメージをステージング／本番で再利用できる。
 *
 * Secret Key は絶対に含めない。
 */
export type RuntimeConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  appBaseUrl: string;
  turnstileSiteKey: string | null;
};

const RuntimeConfigContext = createContext<RuntimeConfig | null>(null);

export function RuntimeConfigProvider({
  value,
  children,
}: {
  value: RuntimeConfig;
  children: ReactNode;
}) {
  return <RuntimeConfigContext.Provider value={value}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
  const config = useContext(RuntimeConfigContext);
  if (!config) {
    throw new Error('RuntimeConfigProvider が見つかりません');
  }
  return config;
}

export function useSupabaseClient(): SupabaseClient<Database> {
  const config = useRuntimeConfig();
  return useMemo(() => {
    if (!config.supabaseUrl || !config.supabasePublishableKey) {
      throw new Error('SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY が設定されていません');
    }
    return getSupabaseBrowserClient(config.supabaseUrl, config.supabasePublishableKey);
  }, [config.supabaseUrl, config.supabasePublishableKey]);
}

export function useIsConfigured(): boolean {
  const config = useContext(RuntimeConfigContext);
  return Boolean(config?.supabaseUrl && config?.supabasePublishableKey);
}
