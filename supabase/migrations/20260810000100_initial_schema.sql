-- =============================================================================
-- SmileQ Live 初期スキーマ
-- =============================================================================
-- 原則:
--   * PostgreSQL を唯一の正しい永続状態とする
--   * 参加トークンは平文を保存せず SHA-256 ハッシュのみ保持する
--   * 参加者 1 人・1 問につき回答レコードは最大 1 件
--   * 数値は numeric(30,10) で保持し、浮動小数点比較で正誤を決めない
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- -----------------------------------------------------------------------------
-- 列挙型
-- -----------------------------------------------------------------------------
create type public.quiz_status as enum ('draft', 'published', 'archived');

create type public.question_type as enum ('choice', 'number');

create type public.number_judgement_mode as enum (
  'exact',
  'absolute_tolerance',
  'range'
);

create type public.room_phase as enum (
  'lobby',
  'question_ready',
  'question_open',
  'question_locked',
  'answer_revealed',
  'scoreboard',
  'finished'
);

create type public.room_member_role as enum ('host', 'presenter', 'participant');

-- -----------------------------------------------------------------------------
-- profiles: 司会者・管理者
-- -----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  '司会者・管理者プロフィール。ここに行がある auth ユーザーだけが管理画面を利用できる。';

-- -----------------------------------------------------------------------------
-- media_assets: 画像メタデータ (WebP へ変換済みのものだけ)
-- -----------------------------------------------------------------------------
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  bucket text not null,
  object_path text not null unique,
  mime_type text not null check (mime_type = 'image/webp'),
  byte_size integer not null check (byte_size > 0),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  created_at timestamptz not null default now()
);

create index media_assets_owner_idx on public.media_assets(owner_id);

-- -----------------------------------------------------------------------------
-- quizzes
-- -----------------------------------------------------------------------------
create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  description text check (description is null or char_length(description) <= 2000),
  status public.quiz_status not null default 'draft',
  show_leaderboard boolean not null default true,
  sound_theme text not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index quizzes_owner_idx on public.quizzes(owner_id, updated_at desc);

-- -----------------------------------------------------------------------------
-- questions
-- -----------------------------------------------------------------------------
create table public.questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  position integer not null check (position >= 1),
  question_type public.question_type not null,
  question_text text check (question_text is null or char_length(question_text) <= 1000),
  question_image_asset_id uuid references public.media_assets(id) on delete set null,
  question_image_alt text check (
    question_image_alt is null or char_length(question_image_alt) <= 120
  ),
  reveal_image_asset_id uuid references public.media_assets(id) on delete set null,
  reveal_image_alt text check (
    reveal_image_alt is null or char_length(reveal_image_alt) <= 120
  ),
  explanation text check (
    explanation is null or char_length(explanation) <= 1000
  ),
  time_limit_seconds integer not null default 20
    check (time_limit_seconds between 5 and 180),
  points integer not null default 1000
    check (points between 0 and 10000),

  number_mode public.number_judgement_mode,
  number_correct_value numeric(30,10),
  number_tolerance numeric(30,10),
  number_min_value numeric(30,10),
  number_max_value numeric(30,10),
  number_unit text check (
    number_unit is null or char_length(number_unit) <= 30
  ),
  number_decimal_places smallint not null default 0
    check (number_decimal_places between 0 and 10),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (quiz_id, position) deferrable initially deferred,

  -- 問題文または問題画像の少なくとも一方が必要
  constraint questions_content_required check (
    nullif(btrim(question_text), '') is not null
    or question_image_asset_id is not null
  ),

  -- 数値式は判定モードに必要な値をすべて持つ / 選択式は数値項目を持たない
  constraint questions_number_rule_valid check (
    (
      question_type = 'choice'
      and number_mode is null
      and number_correct_value is null
      and number_tolerance is null
      and number_min_value is null
      and number_max_value is null
    )
    or (
      question_type = 'number'
      and number_mode is not null
      and (
        (number_mode = 'exact'
          and number_correct_value is not null
          and number_tolerance is null
          and number_min_value is null
          and number_max_value is null)
        or
        (number_mode = 'absolute_tolerance'
          and number_correct_value is not null
          and number_tolerance is not null
          and number_tolerance >= 0
          and number_min_value is null
          and number_max_value is null)
        or
        (number_mode = 'range'
          and number_correct_value is null
          and number_tolerance is null
          and number_min_value is not null
          and number_max_value is not null
          and number_min_value <= number_max_value)
      )
    )
  )
);

create index questions_quiz_position_idx on public.questions(quiz_id, position);

-- -----------------------------------------------------------------------------
-- choices: 選択式問題の 2〜5 選択肢
-- -----------------------------------------------------------------------------
create table public.choices (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  position integer not null check (position between 1 and 5),
  choice_text text check (choice_text is null or char_length(choice_text) <= 300),
  image_asset_id uuid references public.media_assets(id) on delete set null,
  image_alt text check (image_alt is null or char_length(image_alt) <= 120),
  is_correct boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (question_id, position) deferrable initially deferred,
  constraint choices_content_required check (
    nullif(btrim(choice_text), '') is not null
    or image_asset_id is not null
  )
);

-- 正解は 1 問につき最大 1 件（0 件は公開時検証で弾く）
create unique index choices_one_correct_max
  on public.choices(question_id)
  where is_correct = true;

create index choices_question_position_idx on public.choices(question_id, position);

-- 数値式問題に選択肢を作らせない
create or replace function public.assert_choice_parent_is_choice_type()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type public.question_type;
begin
  select question_type into v_type from public.questions where id = new.question_id;
  if v_type is null then
    raise exception 'QUESTION_NOT_FOUND' using errcode = '23503';
  end if;
  if v_type <> 'choice' then
    raise exception 'CHOICE_ON_NON_CHOICE_QUESTION' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger choices_parent_type_check
before insert or update on public.choices
for each row execute function public.assert_choice_parent_is_choice_type();

-- -----------------------------------------------------------------------------
-- rooms: 実施中・実施済みルーム
-- -----------------------------------------------------------------------------
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  quiz_id uuid not null references public.quizzes(id) on delete restrict,
  join_token_hash text not null unique,
  join_token_rotated_at timestamptz not null default now(),
  phase public.room_phase not null default 'lobby',
  quiz_snapshot jsonb not null,
  current_question_id uuid,
  current_question_position integer,
  phase_started_at timestamptz,
  answer_deadline_at timestamptz,
  state_version bigint not null default 0,
  join_open boolean not null default true,
  max_participants integer not null default 200
    check (max_participants between 2 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index rooms_owner_id_idx on public.rooms(owner_id, created_at desc);
create index rooms_phase_idx on public.rooms(phase);

comment on column public.rooms.quiz_snapshot is
  '開催時点のクイズ全体（正解情報を含む）。参加者へ直接 SELECT させないこと。';

-- -----------------------------------------------------------------------------
-- room_members: 司会者・投影担当・参加者
-- -----------------------------------------------------------------------------
create table public.room_members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  role public.room_member_role not null,
  nickname citext,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  is_active boolean not null default true,
  unique (room_id, auth_user_id),
  constraint room_members_nickname_rule check (
    (role = 'participant'
      and nickname is not null
      and char_length(nickname::text) between 1 and 20)
    or (role in ('host', 'presenter'))
  )
);

-- 同一ルーム内で大文字小文字を区別せずニックネーム重複を禁止
create unique index room_members_unique_participant_nickname
  on public.room_members(room_id, lower(nickname::text))
  where role = 'participant' and nickname is not null;

create index room_members_room_role_idx on public.room_members(room_id, role);
create index room_members_auth_user_idx on public.room_members(auth_user_id);

-- -----------------------------------------------------------------------------
-- answers
-- -----------------------------------------------------------------------------
create table public.answers (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  question_id uuid not null,
  participant_id uuid not null references public.room_members(id) on delete cascade,
  answer_type public.question_type not null,
  choice_id uuid,
  number_raw text check (number_raw is null or char_length(number_raw) <= 64),
  number_value numeric(30,10),
  answered_at timestamptz not null default clock_timestamp(),
  elapsed_ms integer not null check (elapsed_ms >= 0),
  is_correct boolean not null,
  points_awarded integer not null default 0 check (points_awarded >= 0),
  unique (room_id, question_id, participant_id),
  constraint answers_payload_matches_type check (
    (answer_type = 'choice'
      and choice_id is not null
      and number_raw is null
      and number_value is null)
    or
    (answer_type = 'number'
      and choice_id is null
      and number_raw is not null
      and number_value is not null)
  )
);

create index answers_room_question_idx on public.answers(room_id, question_id);
create index answers_participant_idx on public.answers(participant_id);
create index answers_room_participant_idx on public.answers(room_id, participant_id);

-- -----------------------------------------------------------------------------
-- presentation_links: 投影用一時リンク
-- -----------------------------------------------------------------------------
create table public.presentation_links (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index presentation_links_room_idx on public.presentation_links(room_id);

-- -----------------------------------------------------------------------------
-- room_events: 状態変更監査ログ
-- -----------------------------------------------------------------------------
create table public.room_events (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  state_version bigint not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (room_id, state_version)
);

create index room_events_room_idx on public.room_events(room_id, state_version desc);

-- -----------------------------------------------------------------------------
-- updated_at トリガー
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger quizzes_set_updated_at
before update on public.quizzes
for each row execute function public.set_updated_at();

create trigger questions_set_updated_at
before update on public.questions
for each row execute function public.set_updated_at();

create trigger choices_set_updated_at
before update on public.choices
for each row execute function public.set_updated_at();

create trigger rooms_set_updated_at
before update on public.rooms
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- auth.users 作成時に profiles を自動作成する（招待運用のため）
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- 匿名ユーザー（参加者）は profiles を作らない。
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;

  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();
