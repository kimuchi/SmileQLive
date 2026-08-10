-- =============================================================================
-- SmileQ Live PostgreSQL 関数
-- =============================================================================
-- 方針:
--   * DB を唯一の正とする。締切判定・正誤判定・順位付けはすべてここで行う。
--   * 数値の正誤判定は numeric のみで行う。double precision へ落とさない。
--   * エラーは `raise exception '<CODE>' using errcode = 'P0001'` で返し、
--     CODE は src/lib/errors/app-error.ts の AppErrorCode と一致させる。
--   * 返り値の JSON キーは src/domain 配下の TypeScript 型と一致させる。
--   * すべて security definer + set search_path = public, pg_temp。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 共通ヘルパー
-- -----------------------------------------------------------------------------

-- ISO8601 (UTC, ミリ秒) 文字列。JavaScript の Date.parse がそのまま扱える形。
create or replace function public.iso8601_utc(p_at timestamptz)
returns text
language sql
stable
as $$
  select case
    when p_at is null then null
    else to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  end;
$$;

comment on function public.iso8601_utc(timestamptz) is
  'timestamptz を ISO8601 (UTC・ミリ秒) 文字列へ変換する。';

-- MediaRef ( { assetId, url, alt, width, height } ) を組み立てる。
-- url は 'storage://<bucket>/<object_path>' 形式。署名 URL / 公開 URL への解決はアプリ側で行う。
create or replace function public.media_ref(p_asset_id uuid, p_alt text)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_asset_id is null then null::jsonb
    else (
      select jsonb_build_object(
        'assetId', m.id,
        'url', 'storage://' || m.bucket || '/' || m.object_path,
        'alt', coalesce(p_alt, ''),
        'width', m.width,
        'height', m.height
      )
      from public.media_assets m
      where m.id = p_asset_id
    )
  end;
$$;

comment on function public.media_ref(uuid, text) is
  'media_assets から MediaRef JSON を組み立てる。url は storage://<bucket>/<object_path>。';

-- NumberRule JSON。数値はすべて trim_scale(...)::text で文字列化する
-- （末尾の余分な 0 を落とし、JavaScript の number へ暗黙変換させない）。
create or replace function public.number_rule_json(
  p_mode public.number_judgement_mode,
  p_correct_value numeric,
  p_tolerance numeric,
  p_min_value numeric,
  p_max_value numeric
)
returns jsonb
language sql
stable
as $$
  select case p_mode
    when 'exact' then jsonb_build_object(
      'mode', 'exact',
      'correctValue', trim_scale(p_correct_value)::text
    )
    when 'absolute_tolerance' then jsonb_build_object(
      'mode', 'absolute_tolerance',
      'correctValue', trim_scale(p_correct_value)::text,
      'tolerance', trim_scale(p_tolerance)::text
    )
    when 'range' then jsonb_build_object(
      'mode', 'range',
      'minValue', trim_scale(p_min_value)::text,
      'maxValue', trim_scale(p_max_value)::text
    )
  end;
$$;

comment on function public.number_rule_json(
  public.number_judgement_mode, numeric, numeric, numeric, numeric
) is 'src/domain/quiz/question.ts の NumberRule と同じ形の JSON を返す。値は必ず文字列。';

-- 表示用の数値整形。src/domain/answer/number-judgement.ts の
-- formatNumberForDisplay (ROUND_HALF_UP + 3 桁区切り) と同じ結果を返す。
create or replace function public.format_number_display(
  p_value numeric,
  p_decimal_places integer
)
returns text
language plpgsql
stable
as $$
declare
  v_places integer := least(greatest(coalesce(p_decimal_places, 0), 0), 10);
  v_pattern text;
begin
  if p_value is null then
    return null;
  end if;

  -- numeric の round() は「0 から遠い方へ」丸める = decimal.js の ROUND_HALF_UP と一致。
  -- FM 修飾子で先頭の空白・ゼロ（および対応する桁区切りカンマ）を抑制する。
  v_pattern := 'FM999,999,999,999,999,999,999,999,999,990';
  if v_places > 0 then
    v_pattern := v_pattern || '.' || repeat('0', v_places);
  end if;

  return to_char(round(p_value, v_places), v_pattern);
end;
$$;

comment on function public.format_number_display(numeric, integer) is
  '表示用に数値を丸めて 3 桁区切りにする。判定には使わない（判定は numeric の生値で行う）。';

-- 正解条件の表示文字列。src/domain/answer/number-judgement.ts の describeNumberRule と同じ。
-- 正解発表後にだけ利用すること。
create or replace function public.describe_number_rule(
  p_rule jsonb,
  p_decimal_places integer,
  p_unit text
)
returns text
language plpgsql
stable
as $$
declare
  v_mode text;
  v_suffix text;
  v_center numeric;
  v_tolerance numeric;
begin
  if p_rule is null then
    return '';
  end if;

  v_mode := p_rule ->> 'mode';
  v_suffix := case when p_unit is null or p_unit = '' then '' else ' ' || p_unit end;

  if v_mode = 'exact' then
    return public.format_number_display((p_rule ->> 'correctValue')::numeric, p_decimal_places)
      || v_suffix;
  elsif v_mode = 'absolute_tolerance' then
    v_center := (p_rule ->> 'correctValue')::numeric;
    v_tolerance := (p_rule ->> 'tolerance')::numeric;
    return public.format_number_display(v_center, p_decimal_places) || v_suffix
      || ' ± ' || public.format_number_display(v_tolerance, p_decimal_places) || v_suffix
      || '（' || public.format_number_display(v_center - v_tolerance, p_decimal_places)
      || ' 〜 ' || public.format_number_display(v_center + v_tolerance, p_decimal_places)
      || v_suffix || '）';
  elsif v_mode = 'range' then
    return public.format_number_display((p_rule ->> 'minValue')::numeric, p_decimal_places)
      || ' 〜 ' || public.format_number_display((p_rule ->> 'maxValue')::numeric, p_decimal_places)
      || v_suffix;
  end if;

  return '';
end;
$$;

comment on function public.describe_number_rule(jsonb, integer, text) is
  '数値問題の正解条件を日本語表示文字列にする。正解発表後にのみ参加者・投影へ出す。';

-- スナップショットから問題 1 件を取り出す。
create or replace function public.snapshot_question(p_snapshot jsonb, p_question_id uuid)
returns jsonb
language sql
immutable
as $$
  select q
  from jsonb_array_elements(
    case
      when jsonb_typeof(p_snapshot -> 'questions') = 'array' then p_snapshot -> 'questions'
      else '[]'::jsonb
    end
  ) as q
  where p_question_id is not null
    and q ->> 'id' = p_question_id::text
  limit 1;
$$;

comment on function public.snapshot_question(jsonb, uuid) is
  'rooms.quiz_snapshot から問題 1 件（正解情報を含む）を取り出す。参加者へそのまま返さないこと。';

-- 状態機械。src/domain/room/state-machine.ts と同じ遷移表。
-- 遷移できない場合は NULL を返す。
create or replace function public.room_next_phase(
  p_phase public.room_phase,
  p_action text
)
returns public.room_phase
language sql
immutable
as $$
  select case p_action
    when 'show_question' then
      case when p_phase in ('lobby', 'answer_revealed', 'scoreboard')
        then 'question_ready'::public.room_phase end
    when 'open_question' then
      case when p_phase = 'question_ready'
        then 'question_open'::public.room_phase end
    when 'lock_question' then
      case when p_phase = 'question_open'
        then 'question_locked'::public.room_phase end
    when 'reveal_answer' then
      case when p_phase = 'question_locked'
        then 'answer_revealed'::public.room_phase end
    when 'show_scoreboard' then
      case when p_phase = 'answer_revealed'
        then 'scoreboard'::public.room_phase end
    when 'finish_room' then
      case when p_phase in ('lobby', 'answer_revealed', 'scoreboard', 'question_locked')
        then 'finished'::public.room_phase end
  end;
$$;

comment on function public.room_next_phase(public.room_phase, text) is
  'アクション適用後のフェーズ。遷移不可なら NULL（呼び出し側で INVALID_TRANSITION）。';

-- フェーズ → public チャンネルのイベント種別（events.ts の publicEventTypeForPhase と同じ）。
create or replace function public.room_public_event_type(p_phase public.room_phase)
returns text
language sql
immutable
as $$
  select case p_phase
    when 'lobby' then 'room.lobby_updated'
    when 'question_ready' then 'question.ready'
    when 'question_open' then 'question.opened'
    when 'question_locked' then 'question.locked'
    when 'answer_revealed' then 'answer.revealed'
    when 'scoreboard' then 'scoreboard.shown'
    when 'finished' then 'room.finished'
  end;
$$;

-- 公開前検証の 1 件分。
create or replace function public.publish_issue(
  p_position integer,
  p_question_id uuid,
  p_code text,
  p_message text
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'questionPosition', p_position,
    'questionId', p_question_id,
    'code', p_code,
    'message', p_message
  );
$$;

-- =============================================================================
-- 1. build_quiz_snapshot
-- =============================================================================
create or replace function public.build_quiz_snapshot(p_quiz_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_quiz public.quizzes%rowtype;
  v_questions jsonb;
begin
  select * into v_quiz from public.quizzes where id = p_quiz_id;
  if not found then
    raise exception 'QUIZ_NOT_FOUND' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(src.payload order by src.q_position), '[]'::jsonb)
    into v_questions
  from (
    select
      qs.position as q_position,
      case
        when qs.question_type = 'choice' then
          jsonb_build_object(
            'id', qs.id,
            'type', 'choice',
            'position', qs.position,
            'text', qs.question_text,
            'image', public.media_ref(qs.question_image_asset_id, qs.question_image_alt),
            'revealImage', public.media_ref(qs.reveal_image_asset_id, qs.reveal_image_alt),
            'timeLimitSeconds', qs.time_limit_seconds,
            'points', qs.points,
            'explanation', qs.explanation,
            'choices', (
              select coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'id', c.id,
                    'position', c.position,
                    'text', c.choice_text,
                    'image', public.media_ref(c.image_asset_id, c.image_alt),
                    'isCorrect', c.is_correct
                  )
                  order by c.position
                ),
                '[]'::jsonb
              )
              from public.choices c
              where c.question_id = qs.id
            )
          )
        else
          jsonb_build_object(
            'id', qs.id,
            'type', 'number',
            'position', qs.position,
            'text', qs.question_text,
            'image', public.media_ref(qs.question_image_asset_id, qs.question_image_alt),
            'revealImage', public.media_ref(qs.reveal_image_asset_id, qs.reveal_image_alt),
            'timeLimitSeconds', qs.time_limit_seconds,
            'points', qs.points,
            'explanation', qs.explanation,
            'numberRule', public.number_rule_json(
              qs.number_mode,
              qs.number_correct_value,
              qs.number_tolerance,
              qs.number_min_value,
              qs.number_max_value
            ),
            'unit', qs.number_unit,
            'decimalPlaces', qs.number_decimal_places
          )
      end as payload
    from public.questions qs
    where qs.quiz_id = p_quiz_id
  ) as src;

  return jsonb_build_object(
    'quizId', v_quiz.id,
    'title', v_quiz.title,
    'settings', jsonb_build_object(
      'showLeaderboard', v_quiz.show_leaderboard,
      'soundTheme', v_quiz.sound_theme,
      -- src/domain/room/scoring.ts の DEFAULT_LEADERBOARD_SIZE と同じ既定値。
      'leaderboardSize', 10
    ),
    'questions', v_questions
  );
end;
$$;

comment on function public.build_quiz_snapshot(uuid) is
  'ルーム作成時に固定するクイズスナップショット。正解情報を含むため参加者へ直接返さないこと。';

-- =============================================================================
-- 2. validate_quiz_for_publish
-- =============================================================================
-- 返り値 { ok: boolean, issues: [{questionPosition, questionId, code, message}] }
-- code / message は src/domain/quiz/publish-validation.ts と一致させる。
-- DB でしか確認できない項目（画像アセットの所有者・数値問題の選択肢）だけ
-- 追加コードを用意している。
create or replace function public.validate_quiz_for_publish(p_quiz_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_quiz public.quizzes%rowtype;
  v_issues jsonb := '[]'::jsonb;
  v_question_count integer;
  v_choice_count integer;
  v_correct_count integer;
  v_row record;
  v_choice record;
  v_prefix text;
  v_label text;
begin
  select * into v_quiz from public.quizzes where id = p_quiz_id;
  if not found then
    raise exception 'QUIZ_NOT_FOUND' using errcode = 'P0001';
  end if;

  if nullif(btrim(v_quiz.title), '') is null then
    v_issues := v_issues || public.publish_issue(
      null, null, 'QUIZ_TITLE_REQUIRED', 'クイズタイトルを入力してください'
    );
  end if;

  select count(*) into v_question_count
  from public.questions where quiz_id = p_quiz_id;

  if v_question_count = 0 then
    v_issues := v_issues || public.publish_issue(
      null, null, 'QUIZ_NO_QUESTIONS', '問題を1問以上作成してください'
    );
    return jsonb_build_object('ok', false, 'issues', v_issues);
  end if;

  -- position が 1 から連続しているか
  for v_row in
    select qs.position as pos, row_number() over (order by qs.position) as rn
    from public.questions qs
    where qs.quiz_id = p_quiz_id
  loop
    if v_row.pos <> v_row.rn then
      v_issues := v_issues || public.publish_issue(
        null, null, 'QUIZ_POSITION_NOT_SEQUENTIAL', '問題の並び順が連続していません'
      );
    end if;
  end loop;

  for v_row in
    select qs.*
    from public.questions qs
    where qs.quiz_id = p_quiz_id
    order by qs.position
  loop
    v_prefix := '第' || v_row.position || '問';

    -- 問題は文章か画像のどちらかが必要
    if nullif(btrim(coalesce(v_row.question_text, '')), '') is null
       and v_row.question_image_asset_id is null then
      v_issues := v_issues || public.publish_issue(
        v_row.position, v_row.id, 'QUESTION_CONTENT_REQUIRED',
        v_prefix || ': 問題文または問題画像のどちらかが必要です'
      );
    end if;

    -- 画像には代替テキストが必要
    if v_row.question_image_asset_id is not null
       and nullif(btrim(coalesce(v_row.question_image_alt, '')), '') is null then
      v_issues := v_issues || public.publish_issue(
        v_row.position, v_row.id, 'QUESTION_IMAGE_ALT_REQUIRED',
        v_prefix || ': 問題画像に代替テキストが必要です'
      );
    end if;

    if v_row.reveal_image_asset_id is not null
       and nullif(btrim(coalesce(v_row.reveal_image_alt, '')), '') is null then
      v_issues := v_issues || public.publish_issue(
        v_row.position, v_row.id, 'REVEAL_IMAGE_ALT_REQUIRED',
        v_prefix || ': 正解・解説画像に代替テキストが必要です'
      );
    end if;

    -- 制限時間・配点
    if v_row.time_limit_seconds is null
       or v_row.time_limit_seconds < 5 or v_row.time_limit_seconds > 180 then
      v_issues := v_issues || public.publish_issue(
        v_row.position, v_row.id, 'QUESTION_TIME_LIMIT_RANGE',
        v_prefix || ': 制限時間は5〜180秒で設定してください'
      );
    end if;

    if v_row.points is null or v_row.points < 0 or v_row.points > 10000 then
      v_issues := v_issues || public.publish_issue(
        v_row.position, v_row.id, 'QUESTION_POINTS_RANGE',
        v_prefix || ': 配点は0〜10000で設定してください'
      );
    end if;

    -- 画像アセットはクイズ所有者のものでなければならない（DB 側だけの検証）
    if exists (
      select 1
      from (values (v_row.question_image_asset_id), (v_row.reveal_image_asset_id)) as a(asset_id)
      where a.asset_id is not null
        and not exists (
          select 1 from public.media_assets m
          where m.id = a.asset_id and m.owner_id = v_quiz.owner_id
        )
    ) then
      v_issues := v_issues || public.publish_issue(
        v_row.position, v_row.id, 'MEDIA_ASSET_OWNER_MISMATCH',
        v_prefix || ': 画像がこのクイズの所有者のものではありません'
      );
    end if;

    if v_row.question_type = 'choice' then
      -- ------------------------------------------------------------------
      -- 選択式
      -- ------------------------------------------------------------------
      select count(*) into v_choice_count
      from public.choices where question_id = v_row.id;

      if v_choice_count < 2 or v_choice_count > 5 then
        v_issues := v_issues || public.publish_issue(
          v_row.position, v_row.id, 'CHOICE_COUNT_RANGE',
          v_prefix || ': 選択肢は2〜5個必要です'
        );
      end if;

      select count(*) into v_correct_count
      from public.choices where question_id = v_row.id and is_correct;

      if v_correct_count <> 1 then
        v_issues := v_issues || public.publish_issue(
          v_row.position, v_row.id, 'CHOICE_CORRECT_COUNT',
          v_prefix || ': 正解を1つ選択してください'
        );
      end if;

      for v_choice in
        select c.position as pos, row_number() over (order by c.position) as rn
        from public.choices c
        where c.question_id = v_row.id
      loop
        if v_choice.pos <> v_choice.rn then
          v_issues := v_issues || public.publish_issue(
            v_row.position, v_row.id, 'CHOICE_POSITION_NOT_SEQUENTIAL',
            v_prefix || ': 選択肢の並び順が不正です'
          );
        end if;
      end loop;

      for v_choice in
        select c.*
        from public.choices c
        where c.question_id = v_row.id
        order by c.position
      loop
        v_label := chr(64 + v_choice.position);

        if nullif(btrim(coalesce(v_choice.choice_text, '')), '') is null
           and v_choice.image_asset_id is null then
          v_issues := v_issues || public.publish_issue(
            v_row.position, v_row.id, 'CHOICE_CONTENT_REQUIRED',
            v_prefix || ': 選択肢' || v_label || 'には文章または画像が必要です'
          );
        end if;

        if v_choice.image_asset_id is not null
           and nullif(btrim(coalesce(v_choice.image_alt, '')), '') is null then
          v_issues := v_issues || public.publish_issue(
            v_row.position, v_row.id, 'CHOICE_IMAGE_ALT_REQUIRED',
            v_prefix || ': 画像のみの選択肢' || v_label || 'には代替テキストが必要です'
          );
        end if;

        if v_choice.image_asset_id is not null
           and not exists (
             select 1 from public.media_assets m
             where m.id = v_choice.image_asset_id and m.owner_id = v_quiz.owner_id
           ) then
          v_issues := v_issues || public.publish_issue(
            v_row.position, v_row.id, 'MEDIA_ASSET_OWNER_MISMATCH',
            v_prefix || ': 画像がこのクイズの所有者のものではありません'
          );
        end if;
      end loop;
    else
      -- ------------------------------------------------------------------
      -- 数値式
      -- ------------------------------------------------------------------
      select count(*) into v_choice_count
      from public.choices where question_id = v_row.id;

      if v_choice_count > 0 then
        v_issues := v_issues || public.publish_issue(
          v_row.position, v_row.id, 'NUMBER_QUESTION_HAS_CHOICES',
          v_prefix || ': 数値問題に選択肢は設定できません'
        );
      end if;

      if v_row.number_decimal_places is null
         or v_row.number_decimal_places < 0 or v_row.number_decimal_places > 10 then
        v_issues := v_issues || public.publish_issue(
          v_row.position, v_row.id, 'NUMBER_DECIMAL_PLACES_RANGE',
          v_prefix || ': 表示小数桁数は0〜10で設定してください'
        );
      end if;

      if v_row.number_unit is not null and char_length(v_row.number_unit) > 30 then
        v_issues := v_issues || public.publish_issue(
          v_row.position, v_row.id, 'NUMBER_UNIT_TOO_LONG',
          v_prefix || ': 単位は30文字以内です'
        );
      end if;

      if v_row.number_mode is null then
        v_issues := v_issues || public.publish_issue(
          v_row.position, v_row.id, 'NUMBER_MODE_REQUIRED',
          v_prefix || ': 判定方法を選択してください'
        );
      elsif v_row.number_mode = 'exact' then
        if v_row.number_correct_value is null then
          v_issues := v_issues || public.publish_issue(
            v_row.position, v_row.id, 'NUMBER_CORRECT_VALUE_REQUIRED',
            v_prefix || ': 数値の正解値を入力してください'
          );
        end if;
      elsif v_row.number_mode = 'absolute_tolerance' then
        if v_row.number_correct_value is null then
          v_issues := v_issues || public.publish_issue(
            v_row.position, v_row.id, 'NUMBER_CORRECT_VALUE_REQUIRED',
            v_prefix || ': 数値の正解値を入力してください'
          );
        end if;
        if v_row.number_tolerance is null then
          v_issues := v_issues || public.publish_issue(
            v_row.position, v_row.id, 'NUMBER_TOLERANCE_REQUIRED',
            v_prefix || ': 許容誤差を入力してください'
          );
        elsif v_row.number_tolerance < 0 then
          v_issues := v_issues || public.publish_issue(
            v_row.position, v_row.id, 'NUMBER_TOLERANCE_NEGATIVE',
            v_prefix || ': 許容誤差は0以上にしてください'
          );
        end if;
      elsif v_row.number_mode = 'range' then
        if v_row.number_min_value is null then
          v_issues := v_issues || public.publish_issue(
            v_row.position, v_row.id, 'NUMBER_MIN_REQUIRED',
            v_prefix || ': 最小値を入力してください'
          );
        end if;
        if v_row.number_max_value is null then
          v_issues := v_issues || public.publish_issue(
            v_row.position, v_row.id, 'NUMBER_MAX_REQUIRED',
            v_prefix || ': 最大値を入力してください'
          );
        end if;
        if v_row.number_min_value is not null
           and v_row.number_max_value is not null
           and v_row.number_min_value > v_row.number_max_value then
          v_issues := v_issues || public.publish_issue(
            v_row.position, v_row.id, 'NUMBER_RANGE_INVALID',
            v_prefix || ': 最小値は最大値以下にしてください'
          );
        end if;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_issues) = 0,
    'issues', v_issues
  );
end;
$$;

comment on function public.validate_quiz_for_publish(uuid) is
  '公開前検証。src/domain/quiz/publish-validation.ts と同じ code / message を返す。';

-- =============================================================================
-- 3. transition_room / lock_question_if_expired
-- =============================================================================
create or replace function public.transition_room(
  p_room_id uuid,
  p_action text,
  p_expected_version bigint,
  p_question_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_next public.room_phase;
  v_now timestamptz := now();
  v_question jsonb;
  v_question_id uuid;
  v_question_position integer;
  v_deadline timestamptz;
  v_finished_at timestamptz;
  v_new_version bigint;
  v_time_limit integer;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_room.owner_id <> v_uid then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;

  -- 楽観ロック。古い画面からの二重操作を弾く。
  if v_room.state_version <> p_expected_version then
    raise exception 'STATE_VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  if v_room.phase = 'finished' or v_room.finished_at is not null then
    raise exception 'ROOM_FINISHED' using errcode = 'P0001';
  end if;

  v_next := public.room_next_phase(v_room.phase, p_action);
  if v_next is null then
    raise exception 'INVALID_TRANSITION' using errcode = 'P0001';
  end if;

  -- 既定値: 現在の問題を引き継ぎ、締切は解除する。
  v_question_id := v_room.current_question_id;
  v_question_position := v_room.current_question_position;
  v_deadline := null;
  v_finished_at := v_room.finished_at;

  if p_action = 'show_question' then
    if p_question_id is null then
      raise exception 'QUESTION_NOT_FOUND' using errcode = 'P0001';
    end if;
    v_question := public.snapshot_question(v_room.quiz_snapshot, p_question_id);
    if v_question is null then
      raise exception 'QUESTION_NOT_FOUND' using errcode = 'P0001';
    end if;
    v_question_id := p_question_id;
    v_question_position := (v_question ->> 'position')::integer;

  elsif p_action = 'open_question' then
    v_question := public.snapshot_question(v_room.quiz_snapshot, v_room.current_question_id);
    if v_question is null then
      raise exception 'QUESTION_NOT_FOUND' using errcode = 'P0001';
    end if;
    v_time_limit := coalesce((v_question ->> 'timeLimitSeconds')::integer, 20);
    -- 締切はサーバー時刻で決める。クライアント時刻は一切使わない。
    v_deadline := v_now + (v_time_limit::text || ' seconds')::interval;

  elsif p_action = 'finish_room' then
    v_question_id := null;
    v_question_position := null;
    v_finished_at := v_now;
  end if;

  v_new_version := v_room.state_version + 1;

  update public.rooms
  set phase = v_next,
      current_question_id = v_question_id,
      current_question_position = v_question_position,
      phase_started_at = v_now,
      answer_deadline_at = v_deadline,
      state_version = v_new_version,
      finished_at = v_finished_at,
      -- 終了後は参加受付も閉じる
      join_open = case when v_next = 'finished' then false else join_open end
  where id = p_room_id;

  insert into public.room_events (room_id, state_version, event_type, payload, actor_user_id)
  values (
    p_room_id,
    v_new_version,
    public.room_public_event_type(v_next),
    jsonb_build_object(
      'action', p_action,
      'phase', v_next,
      'questionId', v_question_id,
      'questionPosition', v_question_position,
      'answerDeadlineAt', public.iso8601_utc(v_deadline)
    ),
    v_uid
  );

  return jsonb_build_object(
    'phase', v_next,
    'stateVersion', v_new_version,
    'serverTime', public.iso8601_utc(v_now),
    'currentQuestionId', v_question_id,
    'currentQuestionPosition', v_question_position,
    'answerDeadlineAt', public.iso8601_utc(v_deadline)
  );
end;
$$;

comment on function public.transition_room(uuid, text, bigint, uuid) is
  'ルームのフェーズ遷移。司会者のみ・楽観ロック付き。state_version を 1 進めて room_events へ記録する。';

-- 締切超過なら question_locked へ進める冪等関数。
-- 参加者・投影・司会のどの端末から同時に呼ばれても 1 回しか進まない
-- （rooms 行の FOR UPDATE で直列化する）。
create or replace function public.lock_question_if_expired(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_now timestamptz := now();
  v_new_version bigint;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  -- ルーム関係者（司会・投影・参加者）だけが呼べる。
  if not (
    public.is_room_owner(p_room_id)
    or public.is_room_member(
      p_room_id,
      array['host', 'presenter', 'participant']::public.room_member_role[]
    )
  ) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- 既に締め切られている / 受付中でない場合は何もしない（冪等）。
  if v_room.phase <> 'question_open'
     or v_room.answer_deadline_at is null
     or v_now <= v_room.answer_deadline_at then
    return jsonb_build_object(
      'changed', false,
      'phase', v_room.phase,
      'stateVersion', v_room.state_version,
      'serverTime', public.iso8601_utc(v_now),
      'currentQuestionId', v_room.current_question_id,
      'currentQuestionPosition', v_room.current_question_position,
      'answerDeadlineAt', public.iso8601_utc(v_room.answer_deadline_at)
    );
  end if;

  v_new_version := v_room.state_version + 1;

  update public.rooms
  set phase = 'question_locked',
      phase_started_at = v_now,
      answer_deadline_at = null,
      state_version = v_new_version
  where id = p_room_id;

  insert into public.room_events (room_id, state_version, event_type, payload, actor_user_id)
  values (
    p_room_id,
    v_new_version,
    public.room_public_event_type('question_locked'::public.room_phase),
    jsonb_build_object(
      'action', 'lock_question',
      'phase', 'question_locked',
      'questionId', v_room.current_question_id,
      'questionPosition', v_room.current_question_position,
      'answerDeadlineAt', null,
      'reason', 'deadline_expired'
    ),
    v_uid
  );

  return jsonb_build_object(
    'changed', true,
    'phase', 'question_locked',
    'stateVersion', v_new_version,
    'serverTime', public.iso8601_utc(v_now),
    'currentQuestionId', v_room.current_question_id,
    'currentQuestionPosition', v_room.current_question_position,
    'answerDeadlineAt', null
  );
end;
$$;

comment on function public.lock_question_if_expired(uuid) is
  '締切時刻を過ぎていたら question_locked へ進める冪等関数。同時呼び出しでも 1 回しか進まない。';

-- =============================================================================
-- 4. register_participant
-- =============================================================================
create or replace function public.register_participant(
  p_room_id uuid,
  p_nickname text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_member public.room_members%rowtype;
  v_nickname text;
  v_count integer;
  v_new_id uuid;
  v_constraint text;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  select * into v_room from public.rooms where id = p_room_id;
  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- 既に参加済みなら、そのまま返す（QR 再読込・再訪問時の冪等）。
  select * into v_member
  from public.room_members
  where room_id = p_room_id and auth_user_id = v_uid;

  if found then
    if v_member.role <> 'participant' then
      -- 司会・投影として登録済みのユーザーは参加者になれない。
      raise exception 'FORBIDDEN' using errcode = 'P0001';
    end if;

    update public.room_members
    set last_seen_at = now(), is_active = true
    where id = v_member.id;

    return jsonb_build_object(
      'participantId', v_member.id,
      'nickname', v_member.nickname::text,
      'roomId', p_room_id
    );
  end if;

  if v_room.finished_at is not null or v_room.phase = 'finished' then
    raise exception 'ROOM_FINISHED' using errcode = 'P0001';
  end if;

  if not v_room.join_open then
    raise exception 'JOIN_CLOSED' using errcode = 'P0001';
  end if;

  v_nickname := btrim(coalesce(p_nickname, ''));
  if char_length(v_nickname) < 1 or char_length(v_nickname) > 20 then
    raise exception 'NICKNAME_INVALID' using errcode = 'P0001';
  end if;

  -- 定員チェックを直列化する。transition_room の行ロックとは競合させない。
  perform pg_advisory_xact_lock(hashtextextended('smileq:join:' || p_room_id::text, 0));

  select count(*) into v_count
  from public.room_members
  where room_id = p_room_id and role = 'participant';

  if v_count >= v_room.max_participants then
    raise exception 'ROOM_FULL' using errcode = 'P0001';
  end if;

  begin
    insert into public.room_members (room_id, auth_user_id, role, nickname)
    values (p_room_id, v_uid, 'participant', v_nickname)
    returning id into v_new_id;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'room_members_unique_participant_nickname' then
        raise exception 'NICKNAME_TAKEN' using errcode = 'P0001';
      end if;

      -- 同一ユーザーの同時二重登録。既存行を返す。
      select * into v_member
      from public.room_members
      where room_id = p_room_id and auth_user_id = v_uid;

      if found then
        return jsonb_build_object(
          'participantId', v_member.id,
          'nickname', v_member.nickname::text,
          'roomId', p_room_id
        );
      end if;

      raise exception 'NICKNAME_TAKEN' using errcode = 'P0001';
  end;

  return jsonb_build_object(
    'participantId', v_new_id,
    'nickname', v_nickname,
    'roomId', p_room_id
  );
end;
$$;

comment on function public.register_participant(uuid, text) is
  '匿名 auth ユーザーを参加者として登録する。再訪時は既存行をそのまま返す冪等動作。';

-- =============================================================================
-- 5. submit_answer
-- =============================================================================
-- 判定順序は仕様書 §22 に厳密に従う。
-- クライアントが送った回答種別は使わず、必ずスナップショットの問題型を基準にする。
create or replace function public.submit_answer(
  p_room_id uuid,
  p_question_id uuid,
  p_choice_id uuid default null,
  p_number_raw text default null,
  p_number_value numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_member public.room_members%rowtype;
  v_room public.rooms%rowtype;
  v_now timestamptz := now();
  v_question jsonb;
  v_type text;
  v_rule jsonb;
  v_mode text;
  v_choice jsonb;
  v_is_correct boolean;
  v_points integer;
  v_elapsed_ms integer;
  v_raw text;
  v_answered_count integer;
begin
  -- 1. 認証
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  -- 2. 有効な参加者か
  select * into v_member
  from public.room_members
  where room_id = p_room_id and auth_user_id = v_uid and role = 'participant';

  if not found or not v_member.is_active then
    raise exception 'NOT_A_PARTICIPANT' using errcode = 'P0001';
  end if;

  -- 3. ルームをロック（状態遷移と回答受付を直列化する）
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- 4. 受付中か
  if v_room.phase <> 'question_open' or v_room.answer_deadline_at is null then
    raise exception 'ANSWER_NOT_OPEN' using errcode = 'P0001';
  end if;

  -- 5. 表示中の問題と一致するか
  if v_room.current_question_id is null or v_room.current_question_id <> p_question_id then
    raise exception 'ANSWER_QUESTION_MISMATCH' using errcode = 'P0001';
  end if;

  -- 6. 締切判定は DB 時刻のみ
  if v_now > v_room.answer_deadline_at then
    raise exception 'ANSWER_DEADLINE_PASSED' using errcode = 'P0001';
  end if;

  -- 7. スナップショットから現在問題を取得
  v_question := public.snapshot_question(v_room.quiz_snapshot, p_question_id);
  if v_question is null then
    raise exception 'QUESTION_NOT_FOUND' using errcode = 'P0001';
  end if;

  v_type := v_question ->> 'type';

  -- 8. 問題型と送信値の組合せ確認
  if v_type = 'choice' then
    if p_choice_id is null or p_number_value is not null
       or nullif(btrim(coalesce(p_number_raw, '')), '') is not null then
      raise exception 'ANSWER_TYPE_MISMATCH' using errcode = 'P0001';
    end if;

    -- 9. 選択肢がその問題のものか
    select c into v_choice
    from jsonb_array_elements(
      case
        when jsonb_typeof(v_question -> 'choices') = 'array' then v_question -> 'choices'
        else '[]'::jsonb
      end
    ) as c
    where c ->> 'id' = p_choice_id::text
    limit 1;

    if v_choice is null then
      raise exception 'INVALID_CHOICE' using errcode = 'P0001';
    end if;

    -- 10. 正誤判定（スナップショットの正解情報のみを使う）
    v_is_correct := coalesce((v_choice ->> 'isCorrect')::boolean, false);
    v_raw := null;

  elsif v_type = 'number' then
    if p_number_value is null or p_choice_id is not null then
      raise exception 'ANSWER_TYPE_MISMATCH' using errcode = 'P0001';
    end if;

    -- 生入力が無ければ正規化済みの値から復元する（answers の CHECK 制約を満たすため）
    v_raw := coalesce(nullif(btrim(coalesce(p_number_raw, '')), ''), trim_scale(p_number_value)::text);

    v_rule := v_question -> 'numberRule';
    v_mode := v_rule ->> 'mode';

    -- 10. 正誤判定は numeric のみで行う。両端を含む。
    if v_mode = 'exact' then
      v_is_correct := (p_number_value = (v_rule ->> 'correctValue')::numeric);
    elsif v_mode = 'absolute_tolerance' then
      v_is_correct := (
        abs(p_number_value - (v_rule ->> 'correctValue')::numeric)
        <= (v_rule ->> 'tolerance')::numeric
      );
    elsif v_mode = 'range' then
      v_is_correct := (
        p_number_value >= (v_rule ->> 'minValue')::numeric
        and p_number_value <= (v_rule ->> 'maxValue')::numeric
      );
    else
      raise exception 'INTERNAL_ERROR' using errcode = 'P0001';
    end if;

  else
    raise exception 'ANSWER_TYPE_MISMATCH' using errcode = 'P0001';
  end if;

  -- 11. 経過時間は DB 時刻で計算する（クライアント時刻は使わない）
  v_elapsed_ms := least(
    greatest(
      0::numeric,
      floor(
        extract(epoch from (v_now - coalesce(v_room.phase_started_at, v_now))) * 1000
      )
    ),
    2147483647::numeric
  )::integer;

  -- 12. 配点
  v_points := case
    when v_is_correct then coalesce((v_question ->> 'points')::integer, 0)
    else 0
  end;

  -- 13. 保存（1 参加者・1 問につき 1 件）
  begin
    insert into public.answers (
      room_id, question_id, participant_id, answer_type,
      choice_id, number_raw, number_value,
      answered_at, elapsed_ms, is_correct, points_awarded
    )
    values (
      p_room_id, p_question_id, v_member.id, v_type::public.question_type,
      p_choice_id, v_raw, p_number_value,
      v_now, v_elapsed_ms, v_is_correct, v_points
    );
  exception
    when unique_violation then
      raise exception 'ANSWER_ALREADY_EXISTS' using errcode = 'P0001';
  end;

  select count(*) into v_answered_count
  from public.answers
  where room_id = p_room_id and question_id = p_question_id;

  -- 14. 参加者へは正誤を返さない
  return jsonb_build_object(
    'accepted', true,
    'answeredAt', public.iso8601_utc(v_now),
    'answeredCount', v_answered_count
  );
end;
$$;

comment on function public.submit_answer(uuid, uuid, uuid, text, numeric) is
  '回答を受け付ける。締切・正誤はすべて DB 側で判定し、参加者へ正誤を返さない。';

-- =============================================================================
-- 6. room_answer_breakdown
-- =============================================================================
create or replace function public.room_answer_breakdown(
  p_room_id uuid,
  p_question_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_question jsonb;
  v_type text;
  v_total integer;
  v_answered integer;
  v_correct integer;
  v_choices jsonb;
  v_frequent jsonb;
begin
  select * into v_room from public.rooms where id = p_room_id;
  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;

  v_question := public.snapshot_question(v_room.quiz_snapshot, p_question_id);
  if v_question is null then
    raise exception 'QUESTION_NOT_FOUND' using errcode = 'P0001';
  end if;

  v_type := v_question ->> 'type';

  select count(*) into v_total
  from public.room_members
  where room_id = p_room_id and role = 'participant';

  select count(*) into v_answered
  from public.answers
  where room_id = p_room_id and question_id = p_question_id;

  if v_type = 'choice' then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'choiceId', x.choice_id,
          'position', x.choice_position,
          'count', x.cnt,
          'ratio', case
            when v_answered = 0 then 0::numeric
            else round(x.cnt::numeric / v_answered, 4)
          end,
          'isCorrect', x.is_correct
        )
        order by x.choice_position
      ),
      '[]'::jsonb
    )
      into v_choices
    from (
      select
        (ch ->> 'id')::uuid as choice_id,
        (ch ->> 'position')::integer as choice_position,
        coalesce((ch ->> 'isCorrect')::boolean, false) as is_correct,
        (
          select count(*)
          from public.answers a
          where a.room_id = p_room_id
            and a.question_id = p_question_id
            and a.choice_id = (ch ->> 'id')::uuid
        ) as cnt
      from jsonb_array_elements(
        case
          when jsonb_typeof(v_question -> 'choices') = 'array' then v_question -> 'choices'
          else '[]'::jsonb
        end
      ) as ch
    ) as x;

    return jsonb_build_object(
      'questionId', p_question_id,
      'type', 'choice',
      'totalParticipants', v_total,
      'answeredCount', v_answered,
      'unansweredCount', greatest(0, v_total - v_answered),
      'choices', v_choices
    );
  end if;

  -- 数値式
  select count(*) into v_correct
  from public.answers
  where room_id = p_room_id and question_id = p_question_id and is_correct;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('value', f.value_text, 'count', f.cnt)
      order by f.ord
    ),
    '[]'::jsonb
  )
    into v_frequent
  from (
    select
      trim_scale(a.number_value)::text as value_text,
      count(*) as cnt,
      row_number() over (order by count(*) desc, a.number_value asc) as ord
    from public.answers a
    where a.room_id = p_room_id
      and a.question_id = p_question_id
      and a.number_value is not null
    group by a.number_value
    order by count(*) desc, a.number_value asc
    limit 5
  ) as f;

  return jsonb_build_object(
    'questionId', p_question_id,
    'type', 'number',
    'totalParticipants', v_total,
    'answeredCount', v_answered,
    'unansweredCount', greatest(0, v_total - v_answered),
    'correctCount', v_correct,
    'incorrectCount', greatest(0, v_answered - v_correct),
    'correctRate', case
      when v_answered = 0 then 0::numeric
      else round(v_correct::numeric / v_answered, 4)
    end,
    'answerRuleDisplay', public.describe_number_rule(
      v_question -> 'numberRule',
      coalesce((v_question ->> 'decimalPlaces')::integer, 0),
      v_question ->> 'unit'
    ),
    'frequentValues', v_frequent
  );
end;
$$;

comment on function public.room_answer_breakdown(uuid, uuid) is
  '回答集計。正解情報を含むため、締切後（answer_revealed 以降）にだけ配信すること。';

-- =============================================================================
-- 7. room_leaderboard
-- =============================================================================
create or replace function public.room_leaderboard(
  p_room_id uuid,
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(coalesce(p_limit, 10), 0);
  v_result jsonb;
begin
  with base as (
    select
      m.id as participant_id,
      m.nickname::text as nickname,
      coalesce(sum(a.points_awarded), 0)::bigint as total_points,
      count(a.id) filter (where a.is_correct) as correct_count,
      coalesce(sum(a.elapsed_ms) filter (where a.is_correct), 0)::bigint
        as correct_elapsed_ms_total,
      m.joined_at as joined_at
    from public.room_members m
    left join public.answers a
      on a.participant_id = m.id and a.room_id = m.room_id
    where m.room_id = p_room_id and m.role = 'participant'
    group by m.id, m.nickname, m.joined_at
  ),
  ranked as (
    select
      b.*,
      rank() over (
        order by b.total_points desc,
                 b.correct_elapsed_ms_total asc,
                 b.joined_at asc,
                 b.nickname asc
      ) as rank_no,
      row_number() over (
        order by b.total_points desc,
                 b.correct_elapsed_ms_total asc,
                 b.joined_at asc,
                 b.nickname asc
      ) as row_no
    from base b
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'participantId', r.participant_id,
        'nickname', r.nickname,
        'totalPoints', r.total_points,
        'correctCount', r.correct_count,
        'correctElapsedMsTotal', r.correct_elapsed_ms_total,
        'joinedAt', public.iso8601_utc(r.joined_at),
        'rank', r.rank_no
      )
      order by r.row_no
    ),
    '[]'::jsonb
  )
    into v_result
  from ranked r
  where r.row_no <= v_limit;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

comment on function public.room_leaderboard(uuid, integer) is
  'ランキング。並びは src/domain/room/scoring.ts の compareForRanking と同一。';

-- =============================================================================
-- 8. room_participant_stats
-- =============================================================================
create or replace function public.room_participant_stats(
  p_room_id uuid,
  p_question_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_question_id uuid := p_question_id;
  v_participants integer;
  v_answered integer := 0;
begin
  if v_question_id is null then
    select current_question_id into v_question_id from public.rooms where id = p_room_id;
  end if;

  select count(*) into v_participants
  from public.room_members
  where room_id = p_room_id and role = 'participant';

  if v_question_id is not null then
    select count(*) into v_answered
    from public.answers
    where room_id = p_room_id and question_id = v_question_id;
  end if;

  return jsonb_build_object(
    'participantCount', v_participants,
    'answeredCount', v_answered
  );
end;
$$;

comment on function public.room_participant_stats(uuid, uuid) is
  '参加者数と現在問題の回答数。Realtime の進捗通知に使う。';

-- =============================================================================
-- 実行権限
-- =============================================================================
-- 既定では public / anon から一切呼べないようにし、必要なものだけ authenticated へ渡す。
revoke all on function public.iso8601_utc(timestamptz) from public, anon, authenticated;
revoke all on function public.media_ref(uuid, text) from public, anon, authenticated;
revoke all on function public.number_rule_json(
  public.number_judgement_mode, numeric, numeric, numeric, numeric
) from public, anon, authenticated;
revoke all on function public.format_number_display(numeric, integer)
  from public, anon, authenticated;
revoke all on function public.describe_number_rule(jsonb, integer, text)
  from public, anon, authenticated;
revoke all on function public.snapshot_question(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.room_next_phase(public.room_phase, text)
  from public, anon, authenticated;
revoke all on function public.room_public_event_type(public.room_phase)
  from public, anon, authenticated;
revoke all on function public.publish_issue(integer, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.build_quiz_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.validate_quiz_for_publish(uuid) from public, anon, authenticated;
revoke all on function public.transition_room(uuid, text, bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.lock_question_if_expired(uuid) from public, anon, authenticated;
revoke all on function public.register_participant(uuid, text) from public, anon, authenticated;
revoke all on function public.submit_answer(uuid, uuid, uuid, text, numeric)
  from public, anon, authenticated;
revoke all on function public.room_answer_breakdown(uuid, uuid) from public, anon, authenticated;
revoke all on function public.room_leaderboard(uuid, integer) from public, anon, authenticated;
revoke all on function public.room_participant_stats(uuid, uuid) from public, anon, authenticated;

-- クライアント（ログイン済み司会者・匿名参加者）が直接 RPC できるもの。
grant execute on function public.transition_room(uuid, text, bigint, uuid) to authenticated;
grant execute on function public.lock_question_if_expired(uuid) to authenticated;
grant execute on function public.register_participant(uuid, text) to authenticated;
grant execute on function public.submit_answer(uuid, uuid, uuid, text, numeric) to authenticated;

-- 残りはサーバー (Cloud Run / service_role) 専用。
grant execute on function public.iso8601_utc(timestamptz) to service_role;
grant execute on function public.media_ref(uuid, text) to service_role;
grant execute on function public.number_rule_json(
  public.number_judgement_mode, numeric, numeric, numeric, numeric
) to service_role;
grant execute on function public.format_number_display(numeric, integer) to service_role;
grant execute on function public.describe_number_rule(jsonb, integer, text) to service_role;
grant execute on function public.snapshot_question(jsonb, uuid) to service_role;
grant execute on function public.room_next_phase(public.room_phase, text) to service_role;
grant execute on function public.room_public_event_type(public.room_phase) to service_role;
grant execute on function public.publish_issue(integer, uuid, text, text) to service_role;
grant execute on function public.build_quiz_snapshot(uuid) to service_role;
grant execute on function public.validate_quiz_for_publish(uuid) to service_role;
grant execute on function public.transition_room(uuid, text, bigint, uuid) to service_role;
grant execute on function public.lock_question_if_expired(uuid) to service_role;
grant execute on function public.register_participant(uuid, text) to service_role;
grant execute on function public.submit_answer(uuid, uuid, uuid, text, numeric) to service_role;
grant execute on function public.room_answer_breakdown(uuid, uuid) to service_role;
grant execute on function public.room_leaderboard(uuid, integer) to service_role;
grant execute on function public.room_participant_stats(uuid, uuid) to service_role;
