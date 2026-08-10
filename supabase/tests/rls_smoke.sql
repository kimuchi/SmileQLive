-- =============================================================================
-- RLS のスモークテスト
-- =============================================================================
-- 「万一クライアントから直接 PostgREST を叩かれても、正解情報と他人のデータが
--  1 行も漏れない」ことを確認する。
--
-- 実行は scripts/test-sql.mjs 経由（functions_smoke.sql の後）。
--
-- 注意: RLS はテーブル所有者・スーパーユーザーには適用されないため、
--       各検査は `set local role authenticated` に切り替えてから行う。
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

do $rls$
declare
  v_host uuid := gen_random_uuid();
  v_participant uuid := gen_random_uuid();
  v_other_host uuid := gen_random_uuid();
  v_quiz uuid;
  v_question uuid;
  v_room uuid;
  v_member uuid;
  v_count integer;
begin
  raise notice '--- 準備';
  insert into auth.users (id, email, is_anonymous)
  values (v_host, 'rls-host@example.test', false), (v_other_host, 'rls-other@example.test', false);
  insert into auth.users (id, is_anonymous) values (v_participant, true);

  insert into public.quizzes (owner_id, title) values (v_host, 'RLS 検証') returning id into v_quiz;
  insert into public.questions (quiz_id, position, question_type, question_text)
  values (v_quiz, 1, 'choice', '秘密の問題') returning id into v_question;
  insert into public.choices (question_id, position, choice_text, is_correct)
  values (v_question, 1, 'はずれ', false), (v_question, 2, 'あたり', true);

  insert into public.rooms (owner_id, quiz_id, join_token_hash, quiz_snapshot)
  values (v_host, v_quiz, encode(digest('rls-token', 'sha256'), 'hex'),
          public.build_quiz_snapshot(v_quiz))
  returning id into v_room;

  insert into public.room_members (room_id, auth_user_id, role, nickname)
  values (v_room, v_participant, 'participant', 'テスト参加者')
  returning id into v_member;

  -- ---------------------------------------------------------------------------
  raise notice '--- 参加者として（匿名 auth ユーザー）';
  perform public.test_set_user(v_participant);
  set local role authenticated;

  select count(*) into v_count from public.questions;
  if v_count <> 0 then
    raise exception 'FAIL: 参加者が questions を % 行 select できた', v_count;
  end if;
  raise notice 'OK: 参加者は questions を select できない';

  select count(*) into v_count from public.choices;
  if v_count <> 0 then
    raise exception 'FAIL: 参加者が choices を % 行 select できた（正解が漏れる）', v_count;
  end if;
  raise notice 'OK: 参加者は choices を select できない（is_correct が漏れない）';

  select count(*) into v_count from public.rooms;
  if v_count <> 0 then
    raise exception 'FAIL: 参加者が rooms を % 行 select できた（quiz_snapshot が漏れる）', v_count;
  end if;
  raise notice 'OK: 参加者は rooms を select できない（quiz_snapshot が漏れない）';

  select count(*) into v_count from public.quizzes;
  if v_count <> 0 then
    raise exception 'FAIL: 参加者が quizzes を % 行 select できた', v_count;
  end if;
  raise notice 'OK: 参加者は quizzes を select できない';

  select count(*) into v_count from public.room_members;
  if v_count <> 1 then
    raise exception 'FAIL: 参加者が見られる room_members は自分の1行のはずが % 行', v_count;
  end if;
  raise notice 'OK: 参加者は自分の room_members 行だけ見える';

  -- 参加者が自分でルームを作れない / 他人のクイズを触れない
  begin
    insert into public.quizzes (owner_id, title) values (v_participant, '乗っ取り');
    raise exception 'FAIL: 参加者がクイズを作成できた';
  exception
    when insufficient_privilege then
      raise notice 'OK: 参加者はクイズを作成できない';
  end;

  begin
    update public.rooms set phase = 'answer_revealed' where id = v_room;
    if found then
      raise exception 'FAIL: 参加者がルームの状態を書き換えられた';
    end if;
    raise notice 'OK: 参加者はルームの状態を書き換えられない';
  exception
    when insufficient_privilege then
      raise notice 'OK: 参加者はルームの状態を書き換えられない';
  end;

  reset role;

  -- ---------------------------------------------------------------------------
  raise notice '--- 別の司会者として';
  perform public.test_set_user(v_other_host);
  set local role authenticated;

  select count(*) into v_count from public.quizzes;
  if v_count <> 0 then
    raise exception 'FAIL: 他人のクイズが % 行見えた', v_count;
  end if;
  raise notice 'OK: 他人のクイズは見えない';

  select count(*) into v_count from public.questions;
  if v_count <> 0 then
    raise exception 'FAIL: 他人の問題が % 行見えた', v_count;
  end if;
  raise notice 'OK: 他人の問題は見えない';

  select count(*) into v_count from public.rooms;
  if v_count <> 0 then
    raise exception 'FAIL: 他人のルームが % 行見えた', v_count;
  end if;
  raise notice 'OK: 他人のルームは見えない';

  reset role;

  -- ---------------------------------------------------------------------------
  raise notice '--- 所有者である司会者として';
  perform public.test_set_user(v_host);
  set local role authenticated;

  select count(*) into v_count from public.quizzes;
  if v_count <> 1 then
    raise exception 'FAIL: 所有者が自分のクイズを見られない (% 行)', v_count;
  end if;

  select count(*) into v_count from public.questions;
  if v_count <> 1 then
    raise exception 'FAIL: 所有者が自分の問題を見られない (% 行)', v_count;
  end if;

  select count(*) into v_count from public.rooms;
  if v_count <> 1 then
    raise exception 'FAIL: 所有者が自分のルームを見られない (% 行)', v_count;
  end if;
  raise notice 'OK: 所有者は自分のクイズ・問題・ルームを見られる';

  reset role;

  -- ---------------------------------------------------------------------------
  raise notice '--- 未認証 (anon) として';
  -- anon には SELECT の GRANT 自体を与えていないため、
  -- RLS で 0 行になるより手前で「権限なし」になるのが正しい（多層防御）。
  perform public.test_set_user(null, 'anon');
  set local role anon;

  begin
    select count(*) into v_count from public.quizzes;
    if v_count <> 0 then
      raise exception 'FAIL: 未認証で quizzes が % 行見えた', v_count;
    end if;
    raise notice 'OK: 未認証では quizzes が 0 行';
  exception
    when insufficient_privilege then
      raise notice 'OK: 未認証は quizzes へアクセスできない（GRANT なし）';
  end;

  begin
    select count(*) into v_count from public.rooms;
    if v_count <> 0 then
      raise exception 'FAIL: 未認証で rooms が % 行見えた', v_count;
    end if;
    raise notice 'OK: 未認証では rooms が 0 行';
  exception
    when insufficient_privilege then
      raise notice 'OK: 未認証は rooms へアクセスできない（GRANT なし）';
  end;

  begin
    select count(*) into v_count from public.choices;
    if v_count <> 0 then
      raise exception 'FAIL: 未認証で choices が % 行見えた（正解が漏れる）', v_count;
    end if;
    raise notice 'OK: 未認証では choices が 0 行';
  exception
    when insufficient_privilege then
      raise notice 'OK: 未認証は choices へアクセスできない（GRANT なし）';
  end;

  reset role;

  raise notice '';
  raise notice '================================';
  raise notice '  RLS スモークテストに成功';
  raise notice '================================';
end
$rls$;
