-- =============================================================================
-- Supabase 互換スタブ（マイグレーション構文検証用）
-- =============================================================================
-- 素の PostgreSQL には auth / realtime スキーマや auth.uid() が無いため、
-- CI やローカルでマイグレーションの構文・制約を検証したいときにだけ読み込む。
--
--   psql -f supabase/tests/_supabase_stubs.sql
--   psql -f supabase/migrations/20260810000100_initial_schema.sql
--   ...
--
-- 本番 Supabase へは絶対に適用しないこと。
-- =============================================================================

create schema if not exists auth;
create schema if not exists realtime;
create schema if not exists storage;

-- Supabase の組み込みロール
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_realtime_admin') then
    create role supabase_realtime_admin nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema realtime to anon, authenticated, service_role;

-- auth.users の最小スタブ
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  is_anonymous boolean not null default false,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- 現在のユーザー ID。テストでは set_config('request.jwt.claim.sub', ...) で切り替える。
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

-- realtime.messages の最小スタブ（private channel の RLS 検証用）
create table if not exists realtime.messages (
  id bigint generated always as identity primary key,
  topic text not null,
  extension text not null default 'broadcast',
  event text,
  payload jsonb,
  private boolean not null default true,
  inserted_at timestamptz not null default now()
);

create or replace function realtime.topic()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('realtime.topic', true), ''), '');
$$;

-- 検証用のヘルパー: 指定ユーザーとして実行する
create or replace function public.test_set_user(p_user_id uuid, p_role text default 'authenticated')
returns void
language sql
as $$
  select set_config('request.jwt.claim.sub', coalesce(p_user_id::text, ''), true),
         set_config('request.jwt.claim.role', p_role, true);
  select null::void;
$$;
