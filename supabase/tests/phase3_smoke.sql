-- =====================================================================
-- Phase 3 本番スモークテスト（docs/phase3-plan.md 6章）
--
-- 何をするか：本物の Supabase 上で、「分析に含めない」の印の切り替え（本人だけ・記録は変わらない）と、
--   延期・見送りのイベントを予定日で引くビュー occurrence_reason_facts（本人の行だけ）を確かめる。
-- データを残さない仕組み（Phase 1・2 と同じ）：
--   全体を1つの DO ブロック（＝1つの文）にし、最後に必ず例外を出す。例外で終わった文は丸ごと取り消される。
--   結果は、最後の例外のメッセージ（SMOKE_OK / SMOKE_NG）で返す。
-- 外部への影響：
--   - テスト用ユーザーは auth.users に直接 INSERT する（メールは送られない）
--   - 送信は起きない：テストの予定は明日の 23:55 で、通知ジョブは取り消される途中のデータのため毎分の cron から見えない。
--     送信側の関数（claim_due_jobs など）は呼ばない
--   - 既存ユーザーのルーティン・通知ジョブが変わらないこと、pg_net の送信待ちが増えないことも確かめる
--   - 残るのは、識別用の連番が少し進むことと、DB のログにこの文（秘密情報なし）が残ることだけ
-- 実行（承認後のみ）：npx supabase db query --remote=<ref> -f supabase/tests/phase3_smoke.sql --yes
--   → エラー終了し、メッセージが「SMOKE_OK」なら成功
-- =====================================================================
do $smoke$
declare
  v_alice uuid := gen_random_uuid();
  v_bob uuid := gen_random_uuid();
  v_tomorrow date := (now() at time zone 'Asia/Tokyo')::date + 1;
  v_r1 uuid;
  v_occ uuid;
  v_n integer;
  v_b boolean;
  v_s text;
  v_err text;
  v_rows_before text;
  v_rows_after text;
  v_others_before text;
  v_others_after text;
  v_queue_before bigint;
  v_queue_after bigint;
  v_fail text[] := '{}';
  v_checks integer := 0;
begin
  -- 既存ユーザーのルーティン・通知ジョブと pg_net の送信待ちを、始める前に控えておく
  select coalesce(md5(string_agg(r::text, '|' order by r.id)), '') || '/' ||
         coalesce((select md5(string_agg(j::text, '|' order by j.id)) from public.notification_jobs j), '')
    into v_others_before from public.routines r;
  select count(*) into v_queue_before from net.http_request_queue;

  insert into auth.users (id, email, aud, role) values
    (v_alice, 'smoke3-alice@example.invalid', 'authenticated', 'authenticated'),
    (v_bob, 'smoke3-bob@example.invalid', 'authenticated', 'authenticated');

  -- 準備：alice のルーティン（明日 23:55）を作り、明日の予定を延期してから見送る
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice, 'role', 'authenticated')::text, true);
  v_r1 := public.create_routine('smoke3-a', null, '{1,2,3,4,5,6,7}', '23:55', 15, 10);
  select id into v_occ from public.occurrences where routine_id = v_r1 and planned_date = v_tomorrow;
  perform public.postpone(v_occ, '10m', null, 'no_time', null);
  perform public.skip_occurrence(v_occ, 'tired', null);

  -- 1. 新しいルーティンは分析に含める（既定 false）
  select exclude_from_analytics into v_b from public.routines where id = v_r1;
  v_checks := v_checks + 1;
  if v_b is distinct from false then v_fail := v_fail || format('default=%s', v_b); end if;

  -- 2. 本人は「分析に含めない」に切り替えられ、予定・実績・版・イベント・通知ジョブは変わらない
  select md5(concat_ws('|',
           (select string_agg(o::text, ',' order by o.id) from public.occurrences o where o.routine_id = v_r1),
           (select string_agg(v::text, ',' order by v.id) from public.routine_versions v where v.routine_id = v_r1),
           (select string_agg(e::text, ',' order by e.id) from public.occurrence_events e where e.occurrence_id = v_occ),
           (select string_agg(j::text, ',' order by j.id) from public.notification_jobs j where j.occurrence_id = v_occ)))
    into v_rows_before;
  v_b := public.set_routine_analytics(v_r1, true);
  select md5(concat_ws('|',
           (select string_agg(o::text, ',' order by o.id) from public.occurrences o where o.routine_id = v_r1),
           (select string_agg(v::text, ',' order by v.id) from public.routine_versions v where v.routine_id = v_r1),
           (select string_agg(e::text, ',' order by e.id) from public.occurrence_events e where e.occurrence_id = v_occ),
           (select string_agg(j::text, ',' order by j.id) from public.notification_jobs j where j.occurrence_id = v_occ)))
    into v_rows_after;
  select exclude_from_analytics into v_b from public.routines where id = v_r1;
  v_checks := v_checks + 1;
  if v_b is distinct from true then v_fail := v_fail || 'flag not set'::text; end if;
  v_checks := v_checks + 1;
  if v_rows_after is distinct from v_rows_before then v_fail := v_fail || 'records changed by flag'::text; end if;

  -- 3. 延期・見送りのイベントが、予定日・ルーティン付きで本人に見える
  select string_agg(type || ':' || coalesce(reason_code, '-') || ':' || coalesce(postpone_option, '-'), ',' order by event_id)
    into v_s from public.occurrence_reason_facts where routine_id = v_r1 and planned_date = v_tomorrow;
  v_checks := v_checks + 1;
  if v_s is distinct from 'postponed:no_time:10m,skipped:tired:-' then v_fail := v_fail || format('reason facts=%s', v_s); end if;

  -- 4. bob には alice のイベント・予定が見えず、alice のルーティンの印も変えられない
  perform set_config('request.jwt.claims', json_build_object('sub', v_bob, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.occurrence_reason_facts;
  v_checks := v_checks + 1;
  if v_n <> 0 then v_fail := v_fail || format('bob sees reason facts=%s', v_n); end if;
  select count(*) into v_n from public.occurrence_facts;
  v_checks := v_checks + 1;
  if v_n <> 0 then v_fail := v_fail || format('bob sees facts=%s', v_n); end if;
  v_err := null;
  begin
    perform public.set_routine_analytics(v_r1, false);
    v_fail := v_fail || 'bob could change flag'::text;
  exception when no_data_found then
    v_err := 'not_found';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'not_found' then v_fail := v_fail || 'bob change not refused'::text; end if;

  -- 5. 未ログイン（anon）は印を変えられず、イベントのビューも読めない
  execute 'reset role';
  execute 'set local role anon';
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  v_err := null;
  begin
    perform public.set_routine_analytics(v_r1, false);
  exception when insufficient_privilege then
    v_err := 'denied';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'denied' then v_fail := v_fail || 'anon rpc not denied'::text; end if;
  v_err := null;
  begin
    perform 1 from public.occurrence_reason_facts limit 1;
  exception when insufficient_privilege then
    v_err := 'denied';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'denied' then v_fail := v_fail || 'anon view not denied'::text; end if;
  execute 'reset role';

  -- 6. 印は戻せる（alice）
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice, 'role', 'authenticated')::text, true);
  perform public.set_routine_analytics(v_r1, false);
  select exclude_from_analytics into v_b from public.routines where id = v_r1;
  v_checks := v_checks + 1;
  if v_b is distinct from false then v_fail := v_fail || 'flag not cleared'::text; end if;
  execute 'reset role';

  -- 7. 既存ユーザーのルーティン・通知ジョブは変わらず、送信も起きていない
  select coalesce(md5(string_agg(r::text, '|' order by r.id)), '') || '/' ||
         coalesce((select md5(string_agg(j::text, '|' order by j.id)) from public.notification_jobs j where j.user_id not in (v_alice, v_bob)), '')
    into v_others_after from public.routines r where r.user_id not in (v_alice, v_bob);
  v_checks := v_checks + 1;
  if v_others_after <> v_others_before then v_fail := v_fail || 'other users rows changed'::text; end if;
  select count(*) into v_queue_after from net.http_request_queue;
  v_checks := v_checks + 1;
  if v_queue_after <> v_queue_before then v_fail := v_fail || format('net queue %s -> %s', v_queue_before, v_queue_after); end if;

  -- 最後に必ず例外を出して、ここまでのすべてを取り消す
  if cardinality(v_fail) = 0 then
    raise exception 'SMOKE_OK checks=% (rolled back)', v_checks;
  else
    raise exception 'SMOKE_NG checks=% failures=% (rolled back)', v_checks, array_to_string(v_fail, '; ');
  end if;
end;
$smoke$;
