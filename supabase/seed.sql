-- =============================================================================
-- SmileQ Live ローカル開発用シード
-- =============================================================================
-- `supabase db reset` の最後に自動実行される。
--
-- 前提:
--   自己登録は無効 (auth.enable_signup = false) のため、司会者ユーザーは
--   Supabase Auth 側で先に作っておくこと。どちらかの方法で作成する。
--
--   (a) Supabase Studio (http://127.0.0.1:54323) の Authentication → Add user
--       Email: host@example.com / Password: 任意 / Auto Confirm User: ON
--
--   (b) CLI + Admin API
--       curl -sS -X POST 'http://127.0.0.1:54321/auth/v1/admin/users' \
--         -H "apikey: $(supabase status -o json | jq -r .SERVICE_ROLE_KEY)" \
--         -H "Authorization: Bearer $(supabase status -o json | jq -r .SERVICE_ROLE_KEY)" \
--         -H 'Content-Type: application/json' \
--         -d '{"email":"host@example.com","password":"smileq-local","email_confirm":true,
--              "user_metadata":{"display_name":"デモ司会者"}}'
--
--   auth.users へ行が入ると on_auth_user_created トリガーが public.profiles を作る。
--   （匿名ユーザーには profiles を作らない = 参加者は管理画面を使えない）
--
-- 別のメールアドレスを使う場合:
--   psql "$DATABASE_URL" -c "set smileq.seed_owner_email = 'me@example.com'" -f supabase/seed.sql
--   もしくは下の v_owner_email の既定値を書き換える。
--
-- 同じ ID で何度実行しても壊れないよう、固定 UUID + 事前削除で冪等にしている。
-- =============================================================================

do $seed$
declare
  -- ---------------------------------------------------------------------------
  -- 変数化した所有者
  -- ---------------------------------------------------------------------------
  v_owner_email text := coalesce(
    nullif(current_setting('smileq.seed_owner_email', true), ''),
    'host@example.com'
  );
  v_owner_id uuid;

  -- サンプルデータの固定 ID（再実行時に重複させないため）
  v_quiz_id uuid := '11111111-1111-4111-8111-111111111111';
  v_q1 uuid := '11111111-1111-4111-8111-000000000001';  -- 2 択
  v_q2 uuid := '11111111-1111-4111-8111-000000000002';  -- 5 択
  v_q3 uuid := '11111111-1111-4111-8111-000000000003';  -- 数値: exact
  v_q4 uuid := '11111111-1111-4111-8111-000000000004';  -- 数値: absolute_tolerance
  v_q5 uuid := '11111111-1111-4111-8111-000000000005';  -- 数値: range
begin
  select id into v_owner_id
  from auth.users
  where email = v_owner_email
  limit 1;

  if v_owner_id is null then
    raise notice '[seed] 司会者ユーザー % が見つからないためサンプル投入をスキップしました。', v_owner_email;
    raise notice '[seed] supabase/seed.sql 冒頭の手順でユーザーを作成してから、もう一度実行してください。';
    return;
  end if;

  -- profiles はトリガーで作られるが、既存 DB からの移行を考慮して念のため補う。
  insert into public.profiles (id, display_name)
  values (v_owner_id, 'デモ司会者')
  on conflict (id) do nothing;

  -- 既存のサンプルを消してから入れ直す（questions / choices は cascade で消える）。
  delete from public.rooms where quiz_id = v_quiz_id;
  delete from public.quizzes where id = v_quiz_id;

  -- ---------------------------------------------------------------------------
  -- クイズ本体
  -- ---------------------------------------------------------------------------
  insert into public.quizzes (id, owner_id, title, description, status, show_leaderboard, sound_theme)
  values (
    v_quiz_id,
    v_owner_id,
    'SmileQ Live 動作確認クイズ',
    '2択・5択・数値3種（完全一致 / 許容誤差 / 範囲）を 1 つずつ含むサンプル。',
    'published',
    true,
    'default'
  );

  -- ---------------------------------------------------------------------------
  -- 第1問: 2 択
  -- ---------------------------------------------------------------------------
  insert into public.questions (
    id, quiz_id, position, question_type, question_text, explanation,
    time_limit_seconds, points
  )
  values (
    v_q1, v_quiz_id, 1, 'choice',
    '日本の標準時子午線が通るのは兵庫県明石市である。',
    '東経135度の子午線が明石市を通っています。',
    15, 1000
  );

  insert into public.choices (question_id, position, choice_text, is_correct) values
    (v_q1, 1, '正しい', true),
    (v_q1, 2, '誤り',   false);

  -- ---------------------------------------------------------------------------
  -- 第2問: 5 択
  -- ---------------------------------------------------------------------------
  insert into public.questions (
    id, quiz_id, position, question_type, question_text, explanation,
    time_limit_seconds, points
  )
  values (
    v_q2, v_quiz_id, 2, 'choice',
    '次のうち、面積がもっとも広い都道府県はどれでしょう。',
    '北海道が最大で、全国の約 22% を占めます。',
    20, 1000
  );

  insert into public.choices (question_id, position, choice_text, is_correct) values
    (v_q2, 1, '北海道',   true),
    (v_q2, 2, '岩手県',   false),
    (v_q2, 3, '福島県',   false),
    (v_q2, 4, '長野県',   false),
    (v_q2, 5, '新潟県',   false);

  -- ---------------------------------------------------------------------------
  -- 第3問: 数値（完全一致）
  -- ---------------------------------------------------------------------------
  insert into public.questions (
    id, quiz_id, position, question_type, question_text, explanation,
    time_limit_seconds, points,
    number_mode, number_correct_value, number_unit, number_decimal_places
  )
  values (
    v_q3, v_quiz_id, 3, 'number',
    '富士山の標高は何メートルでしょう。',
    '3,776 m（剣ヶ峰）です。',
    25, 1000,
    'exact', 3776, 'm', 0
  );

  -- ---------------------------------------------------------------------------
  -- 第4問: 数値（許容誤差）
  -- ---------------------------------------------------------------------------
  insert into public.questions (
    id, quiz_id, position, question_type, question_text, explanation,
    time_limit_seconds, points,
    number_mode, number_correct_value, number_tolerance, number_unit, number_decimal_places
  )
  values (
    v_q4, v_quiz_id, 4, 'number',
    '東京スカイツリーの高さは何メートルでしょう。（±5 m まで正解）',
    '634 m。「むさし」の語呂合わせです。',
    25, 1000,
    'absolute_tolerance', 634, 5, 'm', 0
  );

  -- ---------------------------------------------------------------------------
  -- 第5問: 数値（範囲）
  -- ---------------------------------------------------------------------------
  insert into public.questions (
    id, quiz_id, position, question_type, question_text, explanation,
    time_limit_seconds, points,
    number_mode, number_min_value, number_max_value, number_unit, number_decimal_places
  )
  values (
    v_q5, v_quiz_id, 5, 'number',
    '成人の平熱はおおよそ何度でしょう。（36.0 〜 37.0 ℃ を正解とします）',
    '個人差がありますが 36 度台が一般的です。',
    20, 500,
    'range', 36.0, 37.0, '℃', 1
  );

  raise notice '[seed] サンプルクイズを投入しました。owner=% quiz=%', v_owner_email, v_quiz_id;

  -- 公開条件を満たしているか、DB 側の検証関数で自己確認する。
  raise notice '[seed] validate_quiz_for_publish = %', public.validate_quiz_for_publish(v_quiz_id);
end;
$seed$;
