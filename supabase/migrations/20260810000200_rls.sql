-- =============================================================================
-- SmileQ Live 行レベルセキュリティ (RLS)
-- =============================================================================
-- 方針:
--   * public スキーマの全テーブルで RLS を有効にする。
--   * 通常の CRUD は Cloud Run の Route Handler が secret key (service_role) で行う。
--     したがって anon / authenticated へ広い権限を与えない。
--     ここで定義するポリシーは「万一クライアントから直接叩かれても
--     他人のデータが 1 行も漏れない」ための二重防壁である。
--   * 参加者（匿名 auth ユーザー）が select できるのは
--       - 自分の room_members 行
--       - 自分の answers 行
--     だけ。questions / choices / rooms.quiz_snapshot / 他人の answers は一切見えない。
--   * 投影担当 (presenter) も自分の room_members 行のみ。状態変更は行えない。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ポリシー用ヘルパー
--   security definer + stable + search_path 固定。
--   ポリシー内から呼ぶため、参照先テーブルの RLS を再帰的に評価させない。
-- -----------------------------------------------------------------------------

-- 管理画面を使える利用者（= profiles 行を持つ非匿名ユーザー）か。
create or replace function public.is_staff_user()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid()
  );
$$;

comment on function public.is_staff_user() is
  '現在の auth ユーザーが司会者・管理者（profiles 行を持つ）か。匿名参加者は false。';

-- 指定クイズの所有者か。
create or replace function public.is_quiz_owner(p_quiz_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.quizzes q
    where q.id = p_quiz_id
      and q.owner_id = auth.uid()
  );
$$;

comment on function public.is_quiz_owner(uuid) is '現在の auth ユーザーが当該クイズの所有者か。';

-- 指定問題が属するクイズの所有者か。
create or replace function public.is_question_owner(p_question_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.questions qs
    join public.quizzes q on q.id = qs.quiz_id
    where qs.id = p_question_id
      and q.owner_id = auth.uid()
  );
$$;

comment on function public.is_question_owner(uuid) is
  '現在の auth ユーザーが当該問題を含むクイズの所有者か。';

-- 指定ルームの所有者（司会者）か。
create or replace function public.is_room_owner(p_room_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.rooms r
    where r.id = p_room_id
      and r.owner_id = auth.uid()
  );
$$;

comment on function public.is_room_owner(uuid) is '現在の auth ユーザーが当該ルームの司会者か。';

-- 指定ルームに、指定ロールのいずれかで参加しているか。
create or replace function public.is_room_member(
  p_room_id uuid,
  p_roles public.room_member_role[] default
    array['host', 'presenter', 'participant']::public.room_member_role[]
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.room_members m
    where m.room_id = p_room_id
      and m.auth_user_id = auth.uid()
      and m.role = any (
        coalesce(
          p_roles,
          array['host', 'presenter', 'participant']::public.room_member_role[]
        )
      )
  );
$$;

comment on function public.is_room_member(uuid, public.room_member_role[]) is
  '現在の auth ユーザーが当該ルームに指定ロールで所属しているか。Realtime のチャンネル制御にも使う。';

-- room_members.id が自分自身の行か（answers のポリシーから使う）。
create or replace function public.is_self_room_member(p_member_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.room_members m
    where m.id = p_member_id
      and m.auth_user_id = auth.uid()
  );
$$;

comment on function public.is_self_room_member(uuid) is
  '指定 room_members 行が現在の auth ユーザー自身のものか。';

-- -----------------------------------------------------------------------------
-- RLS 有効化
-- -----------------------------------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.media_assets        enable row level security;
alter table public.quizzes             enable row level security;
alter table public.questions           enable row level security;
alter table public.choices             enable row level security;
alter table public.rooms               enable row level security;
alter table public.room_members        enable row level security;
alter table public.answers             enable row level security;
alter table public.presentation_links  enable row level security;
alter table public.room_events         enable row level security;

-- 注意: force row level security は付けない。
--       SECURITY DEFINER 関数（テーブル所有者として実行）が RLS を迂回して
--       集計・登録・状態遷移を行えるようにするため。

-- -----------------------------------------------------------------------------
-- profiles: 自分の行のみ
-- -----------------------------------------------------------------------------
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- -----------------------------------------------------------------------------
-- media_assets: 所有者のみ
-- -----------------------------------------------------------------------------
create policy media_assets_select_owner on public.media_assets
  for select to authenticated
  using (owner_id = auth.uid());

create policy media_assets_insert_owner on public.media_assets
  for insert to authenticated
  with check (owner_id = auth.uid() and public.is_staff_user());

create policy media_assets_update_owner on public.media_assets
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy media_assets_delete_owner on public.media_assets
  for delete to authenticated
  using (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- quizzes: 所有者のみ
-- -----------------------------------------------------------------------------
create policy quizzes_select_owner on public.quizzes
  for select to authenticated
  using (owner_id = auth.uid());

create policy quizzes_insert_owner on public.quizzes
  for insert to authenticated
  with check (owner_id = auth.uid() and public.is_staff_user());

create policy quizzes_update_owner on public.quizzes
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy quizzes_delete_owner on public.quizzes
  for delete to authenticated
  using (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- questions: 親クイズの所有者のみ
--   参加者は絶対に select できない（正解値・解説を含むため）。
-- -----------------------------------------------------------------------------
create policy questions_select_owner on public.questions
  for select to authenticated
  using (public.is_quiz_owner(quiz_id));

create policy questions_insert_owner on public.questions
  for insert to authenticated
  with check (public.is_quiz_owner(quiz_id));

create policy questions_update_owner on public.questions
  for update to authenticated
  using (public.is_quiz_owner(quiz_id))
  with check (public.is_quiz_owner(quiz_id));

create policy questions_delete_owner on public.questions
  for delete to authenticated
  using (public.is_quiz_owner(quiz_id));

-- -----------------------------------------------------------------------------
-- choices: 親クイズの所有者のみ（is_correct を含むため参加者へは出さない）
-- -----------------------------------------------------------------------------
create policy choices_select_owner on public.choices
  for select to authenticated
  using (public.is_question_owner(question_id));

create policy choices_insert_owner on public.choices
  for insert to authenticated
  with check (public.is_question_owner(question_id));

create policy choices_update_owner on public.choices
  for update to authenticated
  using (public.is_question_owner(question_id))
  with check (public.is_question_owner(question_id));

create policy choices_delete_owner on public.choices
  for delete to authenticated
  using (public.is_question_owner(question_id));

-- -----------------------------------------------------------------------------
-- rooms: 司会者（所有者）のみ
--   quiz_snapshot に正解情報が入っているため、参加者・投影担当へは 1 行も見せない。
--   投影画面・参加者画面は Route Handler が返す Snapshot DTO だけを使う。
-- -----------------------------------------------------------------------------
create policy rooms_select_owner on public.rooms
  for select to authenticated
  using (owner_id = auth.uid());

create policy rooms_insert_owner on public.rooms
  for insert to authenticated
  with check (owner_id = auth.uid() and public.is_staff_user());

create policy rooms_update_owner on public.rooms
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy rooms_delete_owner on public.rooms
  for delete to authenticated
  using (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- room_members
--   * 参加者・投影担当: 自分の行のみ select
--   * 司会者: 自分のルームの参加者一覧を select / 管理
-- -----------------------------------------------------------------------------
create policy room_members_select_self on public.room_members
  for select to authenticated
  using (auth_user_id = auth.uid());

create policy room_members_select_room_owner on public.room_members
  for select to authenticated
  using (public.is_room_owner(room_id));

create policy room_members_update_room_owner on public.room_members
  for update to authenticated
  using (public.is_room_owner(room_id))
  with check (public.is_room_owner(room_id));

create policy room_members_delete_room_owner on public.room_members
  for delete to authenticated
  using (public.is_room_owner(room_id));

-- 参加登録は public.register_participant() 経由のみ。
-- クライアントからの直接 INSERT ポリシーは作らない。

-- -----------------------------------------------------------------------------
-- answers
--   * 参加者: 自分の回答のみ select（他人の回答は 1 行も見えない）
--   * 司会者: 自分のルームの回答を select（集計・確認用。書き換えはしない）
--   * 回答の作成は public.submit_answer() 経由のみ。INSERT ポリシーは作らない。
-- -----------------------------------------------------------------------------
create policy answers_select_self on public.answers
  for select to authenticated
  using (public.is_self_room_member(participant_id));

create policy answers_select_room_owner on public.answers
  for select to authenticated
  using (public.is_room_owner(room_id));

-- -----------------------------------------------------------------------------
-- presentation_links: 司会者のみ。参加者・投影担当は token_hash すら見られない。
-- -----------------------------------------------------------------------------
create policy presentation_links_select_owner on public.presentation_links
  for select to authenticated
  using (public.is_room_owner(room_id));

create policy presentation_links_insert_owner on public.presentation_links
  for insert to authenticated
  with check (public.is_room_owner(room_id) and created_by = auth.uid());

create policy presentation_links_delete_owner on public.presentation_links
  for delete to authenticated
  using (public.is_room_owner(room_id));

-- -----------------------------------------------------------------------------
-- room_events: 監査ログ。司会者のみ select。書き込みは関数経由のみ。
-- -----------------------------------------------------------------------------
create policy room_events_select_owner on public.room_events
  for select to authenticated
  using (public.is_room_owner(room_id));

-- =============================================================================
-- テーブル権限
-- =============================================================================
-- Supabase の既定では anon / authenticated へ広い権限が付くため、まず全部剥がす。
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;

-- anon（未認証）は public スキーマのテーブルへ一切アクセスできない。
-- 参加も投影も匿名 *認証* を経てから行うため、anon に読ませるものはない。

-- authenticated へは「RLS で自分の行だけに絞られる SELECT」だけを許可する。
-- 書き込みはすべて Route Handler (service_role) か SECURITY DEFINER 関数を通す。
grant select on public.profiles      to authenticated;
grant select on public.media_assets  to authenticated;
grant select on public.quizzes       to authenticated;
grant select on public.questions     to authenticated;
grant select on public.choices       to authenticated;
grant select on public.rooms         to authenticated;
grant select on public.room_members  to authenticated;
grant select on public.answers       to authenticated;

-- 表示名だけは本人が更新できる。
grant update (display_name) on public.profiles to authenticated;

-- サーバー（Cloud Run）は service_role で全テーブルを操作する。
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- =============================================================================
-- 関数権限
-- =============================================================================
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

-- ポリシー評価に必要なヘルパーだけ実行を許可する（真偽値しか返さない）。
revoke all on function public.is_staff_user() from public;
revoke all on function public.is_quiz_owner(uuid) from public;
revoke all on function public.is_question_owner(uuid) from public;
revoke all on function public.is_room_owner(uuid) from public;
revoke all on function public.is_room_member(uuid, public.room_member_role[]) from public;
revoke all on function public.is_self_room_member(uuid) from public;

grant execute on function public.is_staff_user() to anon, authenticated, service_role;
grant execute on function public.is_quiz_owner(uuid) to anon, authenticated, service_role;
grant execute on function public.is_question_owner(uuid) to anon, authenticated, service_role;
grant execute on function public.is_room_owner(uuid) to anon, authenticated, service_role;
grant execute on function public.is_room_member(uuid, public.room_member_role[])
  to anon, authenticated, service_role;
grant execute on function public.is_self_room_member(uuid) to anon, authenticated, service_role;

-- 内部トリガー関数はクライアントから直接呼ばせない。
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;
revoke all on function public.assert_choice_parent_is_choice_type() from public, anon, authenticated;
