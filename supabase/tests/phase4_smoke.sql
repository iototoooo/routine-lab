-- =====================================================================
-- Phase 4 本番スモークテスト（docs/phase4-plan.md 6章）
--
-- 何をするか：本物の Supabase 上で、改善提案の却下（版を変えない）・承認（版を1つ作り、予定と通知を付け直す）、
--   古い提案と 28 日以内の再判断の拒否、本人以外・未ログインの拒否、判断の記録を書き換えられないことを確かめる。
-- データを残さない仕組み（Phase 1〜3 と同じ）：
--   全体を1つの DO ブロック（＝1つの文）にし、最後に必ず例外を出す。例外で終わった文は丸ごと取り消される。
--   結果は、最後の例外のメッセージ（SMOKE_OK / SMOKE_NG）で返す。
-- 外部への影響：
--   - テスト用ユーザーは auth.users に直接 INSERT する（メールは送られない）
--   - 送信は起きない：テストの予定は明日の 22:00 / 23:00 で、作った通知ジョブは取り消される途中のデータのため
--     毎分の cron から見えない。送信側の関数（claim_due_jobs など）は呼ばない
--   - 既存ユーザーのルーティン・版・通知ジョブ・判断の記録が変わらないこと、pg_net の送信待ちが増えないことも確かめる
--   - 残るのは、識別用の連番が少し進むことと、DB のログにこの文（秘密情報なし）が残ることだけ
-- 実行（承認後のみ）：npx supabase db query --remote=<ref> -f supabase/tests/phase4_smoke.sql --yes
--   → エラー終了し、メッセージが「SMOKE_OK」なら成功
-- =====================================================================
do $smoke$
declare
  v_alice uuid := gen_random_uuid();
  v_bob uuid := gen_random_uuid();
  v_tomorrow date := (now() at time zone 'Asia/Tokyo')::date + 1;
  v_r1 uuid;
  v_base uuid;
  v_new uuid;
  v_occ uuid;
  v_n integer;
  v_s text;
  v_err text;
  v_rows_before text;
  v_rows_after text;
  v_others_before text;
  v_others_after text;
  v_queue_before bigint;
  v_queue_after bigint;
  v_ev jsonb := '{"from":"smoke","n":5}';
  v_fail text[] := '{}';
  v_checks integer := 0;
begin
  -- 既存ユーザーのルーティン・版・通知ジョブ・判断の記録と pg_net の送信待ちを、始める前に控えておく
  select coalesce(md5(string_agg(r::text, '|' order by r.id)), '') || '/' ||
         coalesce((select md5(string_agg(v::text, '|' order by v.id)) from public.routine_versions v), '') || '/' ||
         coalesce((select md5(string_agg(j::text, '|' order by j.id)) from public.notification_jobs j), '') || '/' ||
         coalesce((select md5(string_agg(s::text, '|' order by s.id)) from public.suggestions s), '')
    into v_others_before from public.routines r;
  select count(*) into v_queue_before from net.http_request_queue;

  insert into auth.users (id, email, aud, role) values
    (v_alice, 'smoke4-alice@example.invalid', 'authenticated', 'authenticated'),
    (v_bob, 'smoke4-bob@example.invalid', 'authenticated', 'authenticated');

  -- 準備：alice のルーティン（毎日 22:00、15 分）
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice, 'role', 'authenticated')::text, true);
  v_r1 := public.create_routine('smoke4-a', null, '{1,2,3,4,5,6,7}', '22:00', 15, 10);
  select id into v_base from public.routine_versions where routine_id = v_r1 and valid_to is null;
  select id into v_occ from public.occurrences where routine_id = v_r1 and planned_date = v_tomorrow;

  -- 1. 却下は判断だけを記録し、版・予定・イベント・通知ジョブを変えない
  select md5(concat_ws('|',
           (select string_agg(o::text, ',' order by o.id) from public.occurrences o where o.routine_id = v_r1),
           (select string_agg(v::text, ',' order by v.id) from public.routine_versions v where v.routine_id = v_r1),
           (select string_agg(e::text, ',' order by e.id) from public.occurrence_events e where e.occurrence_id = v_occ),
           (select string_agg(j::text, ',' order by j.id) from public.notification_jobs j where j.occurrence_id = v_occ)))
    into v_rows_before;
  perform public.reject_suggestion(v_r1, 'R-03', v_base, v_ev, '{"weekdays":[1,2,3,4,5,6,7],"start_time":"22:00","duration_min":20}');
  select md5(concat_ws('|',
           (select string_agg(o::text, ',' order by o.id) from public.occurrences o where o.routine_id = v_r1),
           (select string_agg(v::text, ',' order by v.id) from public.routine_versions v where v.routine_id = v_r1),
           (select string_agg(e::text, ',' order by e.id) from public.occurrence_events e where e.occurrence_id = v_occ),
           (select string_agg(j::text, ',' order by j.id) from public.notification_jobs j where j.occurrence_id = v_occ)))
    into v_rows_after;
  v_checks := v_checks + 1;
  if v_rows_after is distinct from v_rows_before then v_fail := v_fail || 'reject changed records'::text; end if;
  select string_agg(rule_id || ':' || status, ',') into v_s from public.suggestions where routine_id = v_r1;
  v_checks := v_checks + 1;
  if v_s is distinct from 'R-03:rejected' then v_fail := v_fail || format('after reject=%s', v_s); end if;

  -- 2. 承認（R-01：開始を 23:00 に、明日から）で版が1つ増え、きっかけ＝提案・記録とつながる
  v_new := public.accept_suggestion(v_r1, 'R-01', v_base, v_ev,
             '{"weekdays":[1,2,3,4,5,6,7],"start_time":"23:00","duration_min":15}', v_tomorrow, 'smoke');
  select string_agg(version_no || ':' || source || ':' || to_char(start_time, 'HH24:MI') || ':' || (suggestion_id is not null), ',' order by version_no)
    into v_s from public.routine_versions where routine_id = v_r1;
  v_checks := v_checks + 1;
  if v_s is distinct from '1:manual:22:00:false,2:suggestion:23:00:true' then v_fail := v_fail || format('versions=%s', v_s); end if;
  select count(*) into v_n from public.suggestions s join public.routine_versions v on v.suggestion_id = s.id
   where s.routine_id = v_r1 and s.status = 'accepted' and s.applied_version_id = v_new and v.id = v_new;
  v_checks := v_checks + 1;
  if v_n <> 1 then v_fail := v_fail || format('accepted link=%s', v_n); end if;

  -- 3. 明日の予定は 23:00 になり、送信待ちの通知は新しい時刻の1つだけ
  select count(*) into v_n from public.notification_jobs
   where occurrence_id = v_occ and status = 'pending' and fire_at = (v_tomorrow + time '23:00') at time zone 'Asia/Tokyo';
  v_checks := v_checks + 1;
  if v_n <> 1 then v_fail := v_fail || format('pending new=%s', v_n); end if;
  select count(*) into v_n from public.notification_jobs where occurrence_id = v_occ and status = 'pending';
  v_checks := v_checks + 1;
  if v_n <> 1 then v_fail := v_fail || format('pending total=%s', v_n); end if;

  -- 4. 古い提案（もとにした版が今の版でない）は受け付けない
  v_err := null;
  begin
    perform public.accept_suggestion(v_r1, 'R-02', v_base, v_ev,
              '{"weekdays":[1,2,3,4,5,6],"start_time":"22:00","duration_min":15}', v_tomorrow, null);
  exception when others then
    v_err := sqlerrm;
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'stale_suggestion' then v_fail := v_fail || format('stale=%s', v_err); end if;

  -- 5. 同じルール（R-03）は 28 日以内なら、新しい版に対しても受け付けない
  v_err := null;
  begin
    perform public.reject_suggestion(v_r1, 'R-03', v_new, v_ev, '{"weekdays":[1,2,3,4,5,6,7],"start_time":"23:00","duration_min":20}');
  exception when others then
    v_err := sqlerrm;
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'recently_decided' then v_fail := v_fail || format('recent=%s', v_err); end if;

  -- 6. 判断の記録は画面から書き換えられない
  v_err := null;
  begin
    update public.suggestions set status = 'accepted' where routine_id = v_r1;
  exception when insufficient_privilege then
    v_err := 'denied';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'denied' then v_fail := v_fail || 'update not denied'::text; end if;

  -- 7. bob には alice の記録が見えず、alice のルーティンに判断できない
  perform set_config('request.jwt.claims', json_build_object('sub', v_bob, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.suggestions;
  v_checks := v_checks + 1;
  if v_n <> 0 then v_fail := v_fail || format('bob sees suggestions=%s', v_n); end if;
  v_err := null;
  begin
    perform public.reject_suggestion(v_r1, 'R-02', v_new, v_ev, '{"weekdays":[1,2,3,4,5,6],"start_time":"23:00","duration_min":15}');
  exception when no_data_found then
    v_err := 'not_found';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'not_found' then v_fail := v_fail || 'bob decision not refused'::text; end if;

  -- 8. 未ログイン（anon）は記録を読めず、判断もできない
  execute 'reset role';
  execute 'set local role anon';
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  v_err := null;
  begin
    perform 1 from public.suggestions limit 1;
  exception when insufficient_privilege then
    v_err := 'denied';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'denied' then v_fail := v_fail || 'anon select not denied'::text; end if;
  v_err := null;
  begin
    perform public.reject_suggestion(v_r1, 'R-02', v_new, v_ev, '{}');
  exception when insufficient_privilege then
    v_err := 'denied';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'denied' then v_fail := v_fail || 'anon rpc not denied'::text; end if;
  execute 'reset role';

  -- 9. 既存ユーザーの行は変わらず、送信も起きていない
  select coalesce(md5(string_agg(r::text, '|' order by r.id)), '') || '/' ||
         coalesce((select md5(string_agg(v::text, '|' order by v.id)) from public.routine_versions v where v.user_id not in (v_alice, v_bob)), '') || '/' ||
         coalesce((select md5(string_agg(j::text, '|' order by j.id)) from public.notification_jobs j where j.user_id not in (v_alice, v_bob)), '') || '/' ||
         coalesce((select md5(string_agg(s::text, '|' order by s.id)) from public.suggestions s where s.user_id not in (v_alice, v_bob)), '')
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
