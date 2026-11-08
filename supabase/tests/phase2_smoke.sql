-- =====================================================================
-- Phase 2 本番スモークテスト（docs/phase2-plan.md 6章・判断事項6）
--
-- 何をするか：本物の Supabase 上で、予定の操作に合わせて通知ジョブが作られ・取り消されること、
--   送信側の関数の結果処理と権限が期待どおりであることを確かめる。
-- データを残さない仕組み（Phase 1 と同じ）：
--   全体を1つの DO ブロック（＝1つの文）にし、最後に必ず例外を出す。例外で終わった文は丸ごと取り消される。
--   結果は、最後の例外のメッセージ（SMOKE_OK / SMOKE_NG）で返す。
-- 外部への影響：
--   - テスト用ユーザーは auth.users に直接 INSERT する（メールは送られない）
--   - 送信は起きない：テストのジョブは未来の時刻で、しかも取り消される途中のデータは毎分の cron（別の接続）から見えない。
--     claim_due_jobs（全員のジョブを対象にする）は呼ばない。送信側の関数は、テストのジョブ1件にだけ使う
--   - pg_net の送信待ち（net.http_request_queue）が増えないこと、既存ユーザーのジョブが変わらないことも確かめる
--   - 残るのは、識別用の連番が少し進むことと、DB のログにこの文（秘密情報なし）が残ることだけ
-- 実行（承認後のみ）：npx supabase db query --remote=<ref> -f supabase/tests/phase2_smoke.sql --yes
--   → エラー終了し、メッセージが「SMOKE_OK」なら成功
-- =====================================================================
do $smoke$
declare
  v_alice uuid := gen_random_uuid();
  v_bob uuid := gen_random_uuid();
  v_tomorrow date := (now() at time zone 'Asia/Tokyo')::date + 1;
  v_r1 uuid;
  v_r2 uuid;
  v_r3 uuid;
  v_occ uuid;
  v_occ2 uuid;
  v_occ3 uuid;
  v_job uuid;
  v_n integer;
  v_s text;
  v_err text;
  v_others_before text;
  v_others_after text;
  v_queue_before bigint;
  v_queue_after bigint;
  v_fail text[] := '{}';
  v_checks integer := 0;
begin
  -- 既存ユーザーのジョブと pg_net の送信待ちを、始める前に控えておく
  select coalesce(md5(string_agg(j::text, '|' order by j.id)), '') into v_others_before from public.notification_jobs j;
  select count(*) into v_queue_before from net.http_request_queue;

  insert into auth.users (id, email, aud, role) values
    (v_alice, 'smoke2-alice@example.invalid', 'authenticated', 'authenticated'),
    (v_bob, 'smoke2-bob@example.invalid', 'authenticated', 'authenticated');

  -- 1. 登録すると、明日の予定時刻に initial ジョブ（期限＋60分）ができ、本人だけが見える
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice, 'role', 'authenticated')::text, true);
  v_r1 := public.create_routine('smoke2-a', null, '{1,2,3,4,5,6,7}', '23:55', 15, 10);
  select id into v_occ from public.occurrences where routine_id = v_r1 and planned_date = v_tomorrow;
  select count(*) into v_n from public.notification_jobs j join public.occurrences o on o.id = j.occurrence_id
   where j.occurrence_id = v_occ and j.kind = 'initial' and j.status = 'pending'
     and j.fire_at = o.planned_start_at and j.expires_at = o.planned_start_at + interval '60 minutes';
  v_checks := v_checks + 1;
  if v_n <> 1 then v_fail := v_fail || format('initial job=%s', v_n); end if;

  -- 2. 延期 → 予定時刻の通知は取り消し、再通知ができる。延期し直すと古い再通知を取り消す
  perform public.postpone(v_occ, '10m', null, 'tired', null);
  perform public.postpone(v_occ, '30m', null, null, null);
  select string_agg(kind || ':' || status || ':' || coalesce(cancel_reason, '-'), ',' order by fire_at, kind) into v_s
    from public.notification_jobs where occurrence_id = v_occ;
  v_checks := v_checks + 1;
  if v_s <> 'snooze:cancelled:superseded,snooze:pending:-,initial:cancelled:postponed' then
    v_fail := v_fail || format('postpone jobs=%s', v_s);
  end if;

  -- 3. 見送り → 送っていない通知はすべて取り消し（closed）
  perform public.skip_occurrence(v_occ, 'plans', null);
  select count(*) into v_n from public.notification_jobs where occurrence_id = v_occ and status = 'pending';
  v_checks := v_checks + 1;
  if v_n <> 0 then v_fail := v_fail || format('pending after skip=%s', v_n); end if;

  -- 4. bob には alice の通知ジョブが見えず、送信用の関数も使えない
  perform set_config('request.jwt.claims', json_build_object('sub', v_bob, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.notification_jobs;
  v_checks := v_checks + 1;
  if v_n <> 0 then v_fail := v_fail || format('bob sees jobs=%s', v_n); end if;
  v_err := null;
  begin
    perform public.claim_due_jobs(1);
    v_fail := v_fail || 'authenticated could claim'::text;
  exception when insufficient_privilege then
    v_err := 'denied';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'denied' then v_fail := v_fail || 'claim not denied'::text; end if;
  v_err := null;
  begin
    perform * from public.job_payloads(array[v_occ]);
    v_fail := v_fail || 'authenticated could read payloads'::text;
  exception when insufficient_privilege then
    v_err := 'denied';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'denied' then v_fail := v_fail || 'job_payloads not denied'::text; end if;

  -- 5. 編集で予定時刻が変わる → 古いジョブを取り消して新しい時刻に作り直す。アーカイブ → すべて取り消し
  execute 'reset role';
  v_r2 := public._create_routine(v_alice, now(), 'smoke2-b', null, '{1,2,3,4,5,6,7}', '23:55', 15, 10);
  select id into v_occ2 from public.occurrences where routine_id = v_r2 and planned_date = v_tomorrow;
  perform public._edit_routine(v_alice, now(), v_r2, 'smoke2-b', null, '{1,2,3,4,5,6,7}', '23:45', 15, 10, v_tomorrow, 'smoke edit');
  select string_agg(to_char(fire_at at time zone 'Asia/Tokyo', 'HH24:MI') || ':' || status || ':' || coalesce(cancel_reason, '-'), ',' order by fire_at)
    into v_s from public.notification_jobs where occurrence_id = v_occ2;
  v_checks := v_checks + 1;
  if v_s <> '23:45:pending:-,23:55:cancelled:rescheduled' then v_fail := v_fail || format('edit jobs=%s', v_s); end if;
  perform public._archive_routine(v_alice, now(), v_r2);
  select count(*) into v_n from public.notification_jobs where occurrence_id = v_occ2 and status = 'pending';
  v_checks := v_checks + 1;
  if v_n <> 0 then v_fail := v_fail || format('pending after archive=%s', v_n); end if;

  -- 6. 送信側（テストのジョブ1件だけ）：送ってよいかの判定と文面の情報、成功で「通知済み」とイベント
  v_r3 := public._create_routine(v_alice, now(), 'smoke2-c', null, '{1,2,3,4,5,6,7}', '23:55', 15, 10);
  select id into v_occ3 from public.occurrences where routine_id = v_r3 and planned_date = v_tomorrow;
  select id into v_job from public.notification_jobs where occurrence_id = v_occ3 and status = 'pending';
  update public.notification_jobs set status = 'sending', locked_at = now(), attempts = 1 where id = v_job;
  select count(*) into v_n from public.job_payloads(array[v_job])
   where routine_name = 'smoke2-c' and kind = 'initial' and still_due and planned_duration_min = 15;
  v_checks := v_checks + 1;
  if v_n <> 1 then v_fail := v_fail || 'job_payloads not as expected'::text; end if;
  perform public._finish_job(now(), v_job, true, null);
  select o.status || '/' || j.status || '/' || (select count(*) from public.occurrence_events e where e.occurrence_id = o.id and e.type = 'notified')
    into v_s from public.occurrences o join public.notification_jobs j on j.occurrence_id = o.id where j.id = v_job;
  v_checks := v_checks + 1;
  if v_s <> 'notified/sent/1' then v_fail := v_fail || format('finish=%s', v_s); end if;

  -- 7. 一時的な失敗の再送：期限内なら送信待ちに戻る
  v_r3 := public._create_routine(v_alice, now(), 'smoke2-d', null, '{1,2,3,4,5,6,7}', '23:50', 15, 10);
  select j.id into v_job from public.notification_jobs j join public.occurrences o on o.id = j.occurrence_id
   where o.routine_id = v_r3 and o.planned_date = v_tomorrow and j.status = 'pending';
  update public.notification_jobs set status = 'sending', locked_at = now(), attempts = 1 where id = v_job;
  v_s := public._retry_job(now(), v_job, 'HTTP 503');
  v_checks := v_checks + 1;
  if v_s <> 'retry' then v_fail := v_fail || format('retry=%s', v_s); end if;

  -- 8. 送信は起きていない：pg_net の送信待ちは増えず、既存ユーザーのジョブも変わらない
  select count(*) into v_queue_after from net.http_request_queue;
  v_checks := v_checks + 1;
  if v_queue_after <> v_queue_before then v_fail := v_fail || format('net queue %s -> %s', v_queue_before, v_queue_after); end if;
  select coalesce(md5(string_agg(j::text, '|' order by j.id)), '') into v_others_after
    from public.notification_jobs j where j.user_id not in (v_alice, v_bob);
  v_checks := v_checks + 1;
  if v_others_after <> v_others_before then v_fail := v_fail || 'other users jobs changed'::text; end if;

  -- 最後に必ず例外を出して、ここまでのすべてを取り消す
  if cardinality(v_fail) = 0 then
    raise exception 'SMOKE_OK checks=% (rolled back)', v_checks;
  else
    raise exception 'SMOKE_NG checks=% failures=% (rolled back)', v_checks, array_to_string(v_fail, '; ');
  end if;
end;
$smoke$;
