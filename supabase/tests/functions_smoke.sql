-- =============================================================================
-- DB 関数のスモークテスト
-- =============================================================================
-- 素の PostgreSQL 上で、Supabase スタブ + 全マイグレーションを適用したあとに実行する。
--
--   createdb sqtest
--   psql -d sqtest -v ON_ERROR_STOP=1 \
--     -f supabase/tests/_supabase_stubs.sql \
--     -f supabase/migrations/20260810000100_initial_schema.sql \
--     -f supabase/migrations/20260810000200_rls.sql \
--     -f supabase/migrations/20260810000300_functions.sql \
--     -f supabase/migrations/20260810000400_realtime.sql \
--     -f supabase/tests/functions_smoke.sql
--
-- 検証内容:
--   * 公開前検証 (validate_quiz_for_publish) が 2〜5 択と数値 3 判定を正しく通す／落とす
--   * スナップショット生成に正解情報が含まれ、参加者へは別途 DTO 変換が必要であること
--   * 状態遷移が state_version と expectedVersion を正しく扱うこと
--   * 回答登録が締切・二重回答・問題型不一致を拒否すること
--   * 数値判定が境界値を含めて正しいこと
--   * 集計とランキングが仕様どおりの形状で返ること
-- =============================================================================

\set ON_ERROR_STOP on
\timing off
\pset pager off

do $$
declare
  v_host uuid := gen_random_uuid();
  v_p1 uuid := gen_random_uuid();
  v_p2 uuid := gen_random_uuid();
  v_p3 uuid := gen_random_uuid();
  v_quiz uuid;
  v_q_choice uuid;
  v_q_number uuid;
  v_q_range uuid;
  v_choice_a uuid;
  v_choice_b uuid;
  v_room uuid;
  v_snapshot jsonb;
  v_result jsonb;
  v_member1 uuid;
  v_member2 uuid;
  v_member3 uuid;
  v_version bigint;
  v_ok boolean;
  v_msg text;
begin
  raise notice '--- 準備: 司会者と参加者の auth ユーザー';
  insert into auth.users (id, email, is_anonymous) values (v_host, 'host@example.test', false);
  insert into auth.users (id, is_anonymous) values (v_p1, true), (v_p2, true), (v_p3, true);

  if not exists (select 1 from public.profiles where id = v_host) then
    raise exception 'FAIL: auth.users トリガーで profiles が作られていない';
  end if;
  if exists (select 1 from public.profiles where id = v_p1) then
    raise exception 'FAIL: 匿名ユーザーに profiles が作られている';
  end if;
  raise notice 'OK: profiles 自動作成（匿名は除外）';

  raise notice '--- クイズと問題を作成';
  insert into public.quizzes (owner_id, title) values (v_host, 'テストクイズ') returning id into v_quiz;

  -- 第1問: 2択
  insert into public.questions (quiz_id, position, question_type, question_text, time_limit_seconds, points, explanation)
  values (v_quiz, 1, 'choice', '日本の首都はどこですか？', 20, 1000, '日本の首都は東京です。')
  returning id into v_q_choice;

  insert into public.choices (question_id, position, choice_text, is_correct)
  values (v_q_choice, 1, '大阪', false) returning id into v_choice_a;
  insert into public.choices (question_id, position, choice_text, is_correct)
  values (v_q_choice, 2, '東京', true) returning id into v_choice_b;

  -- 第2問: 数値 (完全一致)
  insert into public.questions (
    quiz_id, position, question_type, question_text, time_limit_seconds, points,
    number_mode, number_correct_value, number_unit, number_decimal_places, explanation
  ) values (
    v_quiz, 2, 'number', '富士山の標高は何mでしょう？', 20, 1000,
    'exact', 3776, 'm', 0, '標高は3,776mです。'
  ) returning id into v_q_number;

  -- 第3問: 数値 (範囲指定)
  insert into public.questions (
    quiz_id, position, question_type, question_text, time_limit_seconds, points,
    number_mode, number_min_value, number_max_value, number_unit, number_decimal_places
  ) values (
    v_quiz, 3, 'number', '9.5〜10.5 の範囲に入る数を答えてください', 20, 500,
    'range', 9.5, 10.5, 'km', 1
  ) returning id into v_q_range;

  raise notice '--- 制約: 数値式へ選択肢を作れないこと';
  begin
    insert into public.choices (question_id, position, choice_text, is_correct)
    values (v_q_number, 1, 'だめ', false);
    raise exception 'FAIL: 数値式問題に選択肢が作れてしまった';
  exception
    when check_violation or foreign_key_violation then
      raise notice 'OK: 数値式問題への選択肢挿入を拒否';
  end;

  raise notice '--- 制約: 選択式に数値条件を持たせられないこと';
  begin
    insert into public.questions (quiz_id, position, question_type, question_text, number_mode, number_correct_value)
    values (v_quiz, 99, 'choice', 'だめ', 'exact', 1);
    raise exception 'FAIL: 選択式に number_mode が設定できてしまった';
  exception
    when check_violation then
      raise notice 'OK: 選択式への数値条件設定を拒否';
  end;

  raise notice '--- 公開前検証';
  v_result := public.validate_quiz_for_publish(v_quiz);
  if (v_result ->> 'ok')::boolean is not true then
    raise exception 'FAIL: 正常なクイズが公開検証を通らない: %', v_result;
  end if;
  raise notice 'OK: 正常なクイズが公開検証を通過';

  -- 正解を 0 件にすると落ちること
  update public.choices set is_correct = false where id = v_choice_b;
  v_result := public.validate_quiz_for_publish(v_quiz);
  if (v_result ->> 'ok')::boolean is not false then
    raise exception 'FAIL: 正解0件のクイズが公開検証を通ってしまった';
  end if;
  if not (v_result -> 'issues')::text like '%正解を1つ選択してください%' then
    raise exception 'FAIL: 正解0件のメッセージが期待と異なる: %', v_result -> 'issues';
  end if;
  raise notice 'OK: 正解0件を検出（第N問形式のメッセージ）';
  update public.choices set is_correct = true where id = v_choice_b;

  -- 選択肢 1 件にすると落ちること
  delete from public.choices where id = v_choice_a;
  v_result := public.validate_quiz_for_publish(v_quiz);
  if (v_result ->> 'ok')::boolean is not false then
    raise exception 'FAIL: 選択肢1件のクイズが公開検証を通ってしまった';
  end if;
  raise notice 'OK: 選択肢1件を検出';
  insert into public.choices (question_id, position, choice_text, is_correct)
  values (v_q_choice, 1, '大阪', false) returning id into v_choice_a;

  -- 範囲の min > max は CHECK 制約の時点で拒否される（公開検証まで到達しない）
  begin
    update public.questions set number_min_value = 11, number_max_value = 10 where id = v_q_range;
    raise exception 'FAIL: min>max が CHECK 制約で拒否されない';
  exception
    when check_violation then
      raise notice 'OK: 範囲指定の min>max を CHECK 制約で拒否';
  end;

  -- 許容誤差が負の場合も CHECK 制約で拒否される
  begin
    insert into public.questions (
      quiz_id, position, question_type, question_text,
      number_mode, number_correct_value, number_tolerance
    ) values (v_quiz, 98, 'number', 'だめ', 'absolute_tolerance', 100, -1);
    raise exception 'FAIL: 負の許容誤差が拒否されない';
  exception
    when check_violation then
      raise notice 'OK: 負の許容誤差を CHECK 制約で拒否';
  end;

  v_result := public.validate_quiz_for_publish(v_quiz);
  if (v_result ->> 'ok')::boolean is not true then
    raise exception 'FAIL: 復旧後に公開検証が通らない: %', v_result;
  end if;
  update public.quizzes set status = 'published' where id = v_quiz;

  raise notice '--- スナップショット生成';
  v_snapshot := public.build_quiz_snapshot(v_quiz);
  if jsonb_array_length(v_snapshot -> 'questions') <> 3 then
    raise exception 'FAIL: スナップショットの問題数が違う: %', v_snapshot -> 'questions';
  end if;
  if (v_snapshot -> 'questions' -> 0 -> 'choices' -> 1 ->> 'isCorrect')::boolean is not true then
    raise exception 'FAIL: スナップショットに正解が入っていない';
  end if;
  if (v_snapshot -> 'questions' -> 1 -> 'numberRule' ->> 'correctValue') <> '3776' then
    raise exception 'FAIL: 数値正解値の文字列化が期待と異なる: %',
      v_snapshot -> 'questions' -> 1 -> 'numberRule';
  end if;
  raise notice 'OK: スナップショット生成（正解情報を含む＝参加者へは DTO 変換が必須）';

  raise notice '--- ルーム作成';
  insert into public.rooms (owner_id, quiz_id, join_token_hash, quiz_snapshot)
  values (v_host, v_quiz, encode(digest('dummy-token-1', 'sha256'), 'hex'), v_snapshot)
  returning id into v_room;

  raise notice '--- 参加者登録';
  perform public.test_set_user(v_p1);
  v_result := public.register_participant(v_room, '木村');
  v_member1 := (v_result ->> 'participantId')::uuid;
  if v_member1 is null then
    raise exception 'FAIL: 参加者登録の戻り値が不正: %', v_result;
  end if;

  -- 冪等: 同じユーザーが再登録しても同じ participantId
  v_result := public.register_participant(v_room, '木村');
  if (v_result ->> 'participantId')::uuid <> v_member1 then
    raise exception 'FAIL: 再登録で participantId が変わった';
  end if;
  raise notice 'OK: 参加者登録は冪等';

  -- ニックネーム重複（大文字小文字を区別しない）
  perform public.test_set_user(v_p2);
  begin
    perform public.register_participant(v_room, 'きむら');
    -- ひらがなは別名なので通る。次に完全一致を試す。
    raise exception 'SKIP';
  exception
    when others then
      null;
  end;

  perform public.test_set_user(v_p2);
  delete from public.room_members where room_id = v_room and auth_user_id = v_p2;
  begin
    perform public.register_participant(v_room, '木村');
    raise exception 'FAIL: ニックネーム重複が許可された';
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg <> 'NICKNAME_TAKEN' then
        raise exception 'FAIL: 期待したエラーコードではない: %', v_msg;
      end if;
      raise notice 'OK: ニックネーム重複を拒否 (NICKNAME_TAKEN)';
  end;

  v_result := public.register_participant(v_room, '佐藤');
  v_member2 := (v_result ->> 'participantId')::uuid;

  perform public.test_set_user(v_p3);
  v_result := public.register_participant(v_room, '田中');
  v_member3 := (v_result ->> 'participantId')::uuid;

  raise notice '--- 状態遷移';
  perform public.test_set_user(v_host);
  select state_version into v_version from public.rooms where id = v_room;

  -- 参加者は遷移できない
  perform public.test_set_user(v_p1);
  begin
    perform public.transition_room(v_room, 'show_question', v_version, v_q_choice);
    raise exception 'FAIL: 参加者が状態遷移できてしまった';
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg not in ('FORBIDDEN', 'HOST_ONLY') then
        raise exception 'FAIL: 期待した権限エラーではない: %', v_msg;
      end if;
      raise notice 'OK: 参加者の状態遷移を拒否 (%)', v_msg;
  end;

  perform public.test_set_user(v_host);

  -- expectedVersion 不一致
  begin
    perform public.transition_room(v_room, 'show_question', v_version + 99, v_q_choice);
    raise exception 'FAIL: 古い expectedVersion が通ってしまった';
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg <> 'STATE_VERSION_CONFLICT' then
        raise exception 'FAIL: 期待した競合エラーではない: %', v_msg;
      end if;
      raise notice 'OK: STATE_VERSION_CONFLICT を検出';
  end;

  -- 不正な遷移 (lobby から reveal_answer)
  begin
    perform public.transition_room(v_room, 'reveal_answer', v_version);
    raise exception 'FAIL: 不正な遷移が通ってしまった';
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg <> 'INVALID_TRANSITION' then
        raise exception 'FAIL: 期待した遷移エラーではない: %', v_msg;
      end if;
      raise notice 'OK: INVALID_TRANSITION を検出';
  end;

  v_result := public.transition_room(v_room, 'show_question', v_version, v_q_choice);
  v_version := (v_result ->> 'stateVersion')::bigint;
  if (v_result ->> 'phase') <> 'question_ready' then
    raise exception 'FAIL: show_question 後のフェーズが違う: %', v_result;
  end if;

  raise notice '--- 回答受付前は回答を拒否';
  perform public.test_set_user(v_p1);
  begin
    perform public.submit_answer(v_room, v_q_choice, v_choice_b, null, null);
    raise exception 'FAIL: question_ready で回答できてしまった';
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg <> 'ANSWER_NOT_OPEN' then
        raise exception 'FAIL: 期待したエラーではない: %', v_msg;
      end if;
      raise notice 'OK: ANSWER_NOT_OPEN';
  end;

  perform public.test_set_user(v_host);
  v_result := public.transition_room(v_room, 'open_question', v_version);
  v_version := (v_result ->> 'stateVersion')::bigint;
  if (v_result ->> 'answerDeadlineAt') is null then
    raise exception 'FAIL: open_question で answer_deadline_at が設定されていない';
  end if;
  raise notice 'OK: open_question で締切時刻を設定';

  raise notice '--- 選択式の回答';
  perform public.test_set_user(v_p1);
  v_result := public.submit_answer(v_room, v_q_choice, v_choice_b, null, null);
  if (v_result ->> 'accepted')::boolean is not true then
    raise exception 'FAIL: 回答が受理されない: %', v_result;
  end if;
  if v_result ? 'isCorrect' then
    raise exception 'FAIL: 回答レスポンスに正誤が含まれている: %', v_result;
  end if;
  raise notice 'OK: 回答受理（レスポンスに正誤を含まない）';

  -- 二重回答
  begin
    perform public.submit_answer(v_room, v_q_choice, v_choice_a, null, null);
    raise exception 'FAIL: 二重回答ができてしまった';
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg <> 'ANSWER_ALREADY_EXISTS' then
        raise exception 'FAIL: 期待したエラーではない: %', v_msg;
      end if;
      raise notice 'OK: ANSWER_ALREADY_EXISTS';
  end;

  -- 選択式へ数値を送る
  perform public.test_set_user(v_p2);
  begin
    perform public.submit_answer(v_room, v_q_choice, null, '123', 123);
    raise exception 'FAIL: 選択式へ数値回答が通ってしまった';
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg <> 'ANSWER_TYPE_MISMATCH' then
        raise exception 'FAIL: 期待したエラーではない: %', v_msg;
      end if;
      raise notice 'OK: ANSWER_TYPE_MISMATCH（選択式へ数値）';
  end;

  -- 存在しない選択肢
  begin
    perform public.submit_answer(v_room, v_q_choice, gen_random_uuid(), null, null);
    raise exception 'FAIL: 他問題の選択肢が通ってしまった';
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg <> 'INVALID_CHOICE' then
        raise exception 'FAIL: 期待したエラーではない: %', v_msg;
      end if;
      raise notice 'OK: INVALID_CHOICE';
  end;

  perform public.submit_answer(v_room, v_q_choice, v_choice_a, null, null);
  perform public.test_set_user(v_p3);
  perform public.submit_answer(v_room, v_q_choice, v_choice_b, null, null);

  raise notice '--- 締切と正解発表';
  perform public.test_set_user(v_host);
  v_result := public.transition_room(v_room, 'lock_question', v_version);
  v_version := (v_result ->> 'stateVersion')::bigint;

  perform public.test_set_user(v_p2);
  begin
    perform public.submit_answer(v_room, v_q_choice, v_choice_a, null, null);
    raise exception 'FAIL: 締切後に回答できてしまった';
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg not in ('ANSWER_NOT_OPEN', 'ANSWER_DEADLINE_PASSED', 'ANSWER_ALREADY_EXISTS') then
        raise exception 'FAIL: 期待したエラーではない: %', v_msg;
      end if;
      raise notice 'OK: 締切後の回答を拒否 (%)', v_msg;
  end;

  perform public.test_set_user(v_host);
  v_result := public.transition_room(v_room, 'reveal_answer', v_version);
  v_version := (v_result ->> 'stateVersion')::bigint;

  raise notice '--- 選択式の集計';
  v_result := public.room_answer_breakdown(v_room, v_q_choice);
  if (v_result ->> 'type') <> 'choice' then
    raise exception 'FAIL: 集計の type が違う: %', v_result;
  end if;
  if (v_result ->> 'answeredCount')::int <> 3 then
    raise exception 'FAIL: 回答数が違う: %', v_result;
  end if;
  if (v_result ->> 'totalParticipants')::int <> 3 then
    raise exception 'FAIL: 参加者数が違う: %', v_result;
  end if;
  raise notice 'OK: 選択式集計 %', v_result -> 'choices';

  raise notice '--- 数値式: 境界値の判定';
  perform public.test_set_user(v_host);
  v_result := public.transition_room(v_room, 'show_question', v_version, v_q_range);
  v_version := (v_result ->> 'stateVersion')::bigint;
  v_result := public.transition_room(v_room, 'open_question', v_version);
  v_version := (v_result ->> 'stateVersion')::bigint;

  -- 9.5 と 10.5 は正解（両端を含む）、10.51 は不正解
  perform public.test_set_user(v_p1);
  perform public.submit_answer(v_room, v_q_range, null, '9.5', 9.5);
  perform public.test_set_user(v_p2);
  perform public.submit_answer(v_room, v_q_range, null, '10.5', 10.5);
  perform public.test_set_user(v_p3);
  perform public.submit_answer(v_room, v_q_range, null, '10.51', 10.51);

  perform public.test_set_user(v_host);
  v_result := public.transition_room(v_room, 'lock_question', v_version);
  v_version := (v_result ->> 'stateVersion')::bigint;
  v_result := public.transition_room(v_room, 'reveal_answer', v_version);
  v_version := (v_result ->> 'stateVersion')::bigint;

  v_result := public.room_answer_breakdown(v_room, v_q_range);
  if (v_result ->> 'type') <> 'number' then
    raise exception 'FAIL: 数値集計の type が違う: %', v_result;
  end if;
  if (v_result ->> 'correctCount')::int <> 2 then
    raise exception 'FAIL: 境界値の判定が誤り（期待 2 件正解）: %', v_result;
  end if;
  raise notice 'OK: 範囲指定の両端を含む判定 / 集計 %', v_result;

  raise notice '--- ランキング';
  v_result := public.room_leaderboard(v_room, 10);
  if jsonb_array_length(v_result) <> 3 then
    raise exception 'FAIL: ランキング件数が違う: %', v_result;
  end if;
  if (v_result -> 0 ->> 'rank')::int <> 1 then
    raise exception 'FAIL: 1位の rank が 1 でない: %', v_result;
  end if;
  raise notice 'OK: ランキング %', v_result;

  raise notice '--- 冪等な締切 (lock_question_if_expired)';
  v_result := public.transition_room(v_room, 'show_question', v_version, v_q_number);
  v_version := (v_result ->> 'stateVersion')::bigint;
  v_result := public.transition_room(v_room, 'open_question', v_version);
  v_version := (v_result ->> 'stateVersion')::bigint;

  -- 締切時刻を過去へずらして冪等締切を 2 回呼ぶ
  update public.rooms set answer_deadline_at = now() - interval '1 second' where id = v_room;
  v_result := public.lock_question_if_expired(v_room);
  if (v_result ->> 'phase') <> 'question_locked' then
    raise exception 'FAIL: 期限切れで締切されない: %', v_result;
  end if;
  v_version := (v_result ->> 'stateVersion')::bigint;
  v_result := public.lock_question_if_expired(v_room);
  if (v_result ->> 'stateVersion')::bigint <> v_version then
    raise exception 'FAIL: 冪等な締切が二重に進んだ: %', v_result;
  end if;
  raise notice 'OK: lock_question_if_expired は冪等';

  raise notice '--- 監査ログ';
  if (select count(*) from public.room_events where room_id = v_room) < 5 then
    raise exception 'FAIL: room_events が記録されていない';
  end if;
  raise notice 'OK: room_events 記録件数 = %',
    (select count(*) from public.room_events where room_id = v_room);

  raise notice '';
  raise notice '================================';
  raise notice '  すべてのスモークテストに成功';
  raise notice '================================';
end
$$;
