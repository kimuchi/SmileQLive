-- =============================================================================
-- SmileQ Live Realtime (private channel) 設定
-- =============================================================================
-- 方針:
--   * Realtime は「状態が変わった」ことを伝える通知だけに使う。
--     実データは必ず Route Handler の Snapshot API から取り直す（DB が唯一の正）。
--   * チャンネルは 2 系統:
--       room:<uuid>:public … 参加者・投影担当・司会が購読できる（正解情報は流さない）
--       room:<uuid>:staff  … 投影担当・司会のみ購読できる（集計・進捗）
--   * クライアントからの Broadcast 送信は許可しない（INSERT ポリシーを作らない）。
--     送信は Cloud Run の Route Handler が service_role で行う。
--   * postgres_changes は使わない。answers / rooms の行変更をそのまま配信すると
--     正解情報や他人の回答が漏れるため、supabase_realtime パブリケーションへ
--     テーブルを追加しない。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- トピック名 → ルーム ID
--   'room:<uuid>:public' / 'room:<uuid>:staff' 以外は NULL を返す。
-- -----------------------------------------------------------------------------
create or replace function public.realtime_room_id(p_topic text)
returns uuid
language sql
immutable
as $$
  select case
    when p_topic ~ '^room:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:(public|staff)$'
      then split_part(p_topic, ':', 2)::uuid
    else null
  end;
$$;

comment on function public.realtime_room_id(text) is
  'Realtime のトピック名からルーム ID を取り出す。形式が違えば NULL。';

revoke all on function public.realtime_room_id(text) from public;
grant execute on function public.realtime_room_id(text) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- supabase_realtime パブリケーション
--   Broadcast のみを使うため、テーブルは 1 つも追加しない。
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'create publication supabase_realtime';
  end if;
exception
  when insufficient_privilege then
    raise notice 'supabase_realtime パブリケーションを作成できませんでした（権限不足）。手動で確認してください。';
end;
$$;

-- -----------------------------------------------------------------------------
-- realtime.messages の RLS（private channel の購読制御）
--   Supabase Realtime は購読要求のたびに realtime.topic() を設定し、
--   このテーブルに対する SELECT 権限を評価する。
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'realtime' and c.relname = 'messages'
  ) then
    raise notice 'realtime.messages が存在しないため Realtime ポリシーの作成をスキップしました。';
    return;
  end if;

  execute 'alter table realtime.messages enable row level security';

  execute 'drop policy if exists smileq_room_public_channel_read on realtime.messages';
  execute 'drop policy if exists smileq_room_staff_channel_read on realtime.messages';

  -- room:<uuid>:public … そのルームの参加者・投影担当・司会だけが購読できる
  execute $policy$
    create policy smileq_room_public_channel_read on realtime.messages
      for select to authenticated
      using (
        realtime.topic() like 'room:%:public'
        and public.realtime_room_id(realtime.topic()) is not null
        and public.is_room_member(
              public.realtime_room_id(realtime.topic()),
              array['host', 'presenter', 'participant']::public.room_member_role[]
            )
      )
  $policy$;

  -- room:<uuid>:staff … 投影担当・司会のみ
  execute $policy$
    create policy smileq_room_staff_channel_read on realtime.messages
      for select to authenticated
      using (
        realtime.topic() like 'room:%:staff'
        and public.realtime_room_id(realtime.topic()) is not null
        and public.is_room_member(
              public.realtime_room_id(realtime.topic()),
              array['host', 'presenter']::public.room_member_role[]
            )
      )
  $policy$;

  -- INSERT ポリシーは意図的に作らない。
  -- クライアントから Broadcast を送らせない（なりすまし・偽の正解発表を防ぐ）。
  execute 'revoke insert, update, delete on realtime.messages from anon, authenticated';
  execute 'grant select on realtime.messages to authenticated';
end;
$$;
