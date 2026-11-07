-- =====================================================================
-- Phase 1 本番スモークテスト（docs/phase1-plan.md 5章・判断事項3）
--
-- 何をするか：本物の Supabase 上で、Phase 1 の権限・RLS・書き込み用の関数が期待どおり動くかを確かめる。
-- データを残さない仕組み：
--   全体を1つの DO ブロック（＝1つの文）にし、最後に必ず例外を出す。例外で終わった文は丸ごと取り消される
--   （ROLLBACK）。途中で失敗しても同じ。CLI がトランザクションをどう扱っても、この文がコミットされることはない。
--   結果は、最後の例外のメッセージ（SMOKE_OK / SMOKE_NG）で返す。
-- 外部への影響：
--   - テスト用ユーザーは auth.users に直接 INSERT する（Auth の API を通さないので、メールは送られない）
--   - 通知ジョブ（notification_jobs）は作らない（Phase 1 の関数は作らない。最後に0件であることも確認）
--   - pg_net は使わない。cron は別の接続で動くので、取り消される途中のデータは見えない
--   - 残るのは、識別用の連番（occurrence_events.id）が少し進むことと、DB のログにこの文（秘密情報なし）が残ることだけ
-- 実行（承認後のみ）：npx supabase db query --remote=<ref> -f supabase/tests/phase1_smoke.sql --yes
--   → エラー終了し、メッセージが「SMOKE_OK」なら成功
-- =====================================================================
do $smoke$
declare
  v_alice uuid := gen_random_uuid();
  v_bob uuid := gen_random_uuid();
  v_routine uuid;
  v_occ uuid;
  v_planned timestamptz;
  v_n integer;
  v_status text;
  v_err text;
  v_fail text[] := '{}';
  v_checks integer := 0;
begin
  insert into auth.users (id, email, aud, role) values
    (v_alice, 'smoke-alice@example.invalid', 'authenticated', 'authenticated'),
    (v_bob, 'smoke-bob@example.invalid', 'authenticated', 'authenticated');

  -- 1. alice（authenticated）：登録すると予定ができ、自分の行は読める
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice, 'role', 'authenticated')::text, true);
  v_routine := public.create_routine('smoke', null, '{1,2,3,4,5,6,7}', '23:55', 15, 10);
  select count(*) into v_n from public.routines;
  v_checks := v_checks + 1;
  if v_n <> 1 then v_fail := v_fail || format('alice routines=%s', v_n); end if;
  select id, planned_start_at into v_occ, v_planned from public.occurrences
   where planned_date = (now() at time zone 'Asia/Tokyo')::date + 1;
  v_checks := v_checks + 1;
  if v_occ is null then v_fail := v_fail || 'tomorrow occurrence missing'::text; end if;
  perform public.postpone(v_occ, '10m', null, 'tired', null);
  select status into v_status from public.occurrences where id = v_occ;
  v_checks := v_checks + 1;
  if v_status <> 'postponed' then v_fail := v_fail || format('postpone status=%s', v_status); end if;

  -- 2. bob：alice の行は見えず、記録もできず、表にも直接書けない
  perform set_config('request.jwt.claims', json_build_object('sub', v_bob, 'role', 'authenticated')::text, true);
  select (select count(*) from public.routines) + (select count(*) from public.routine_versions)
       + (select count(*) from public.occurrences) + (select count(*) from public.occurrence_events)
       + (select count(*) from public.executions) + (select count(*) from public.occurrence_facts)
    into v_n;
  v_checks := v_checks + 1;
  if v_n <> 0 then v_fail := v_fail || format('bob sees %s rows', v_n); end if;
  begin
    perform public.record_done(v_occ, now(), 15, 'now');
    v_fail := v_fail || 'bob could record alice occurrence'::text;
  exception when others then
    v_err := sqlerrm;
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'not_found' then v_fail := v_fail || format('bob record error=%s', v_err); end if;
  v_err := null;
  begin
    insert into public.routines (user_id, name) values (v_bob, 'x');
    v_fail := v_fail || 'bob could insert routines'::text;
  exception when insufficient_privilege then
    v_err := 'denied';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'denied' then v_fail := v_fail || 'direct insert not denied'::text; end if;

  -- 3. anon：入口の関数も使えない
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_err := null;
  begin
    perform public.create_routine('x', null, '{1}', '07:00', 15, 10);
    v_fail := v_fail || 'anon could create'::text;
  exception when insufficient_privilege then
    v_err := 'denied';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'denied' then v_fail := v_fail || 'anon not denied'::text; end if;

  -- 4. 内部の関数（時刻を指定）：完了 → 実績と分析ビュー、編集で版が増える、未実施の確定
  execute 'reset role';
  perform public._record_done(v_alice, v_planned + interval '1 hour', v_occ, v_planned + interval '5 minutes', 20, 'manual');
  select count(*) into v_n from public.occurrence_facts
   where occurrence_id = v_occ and status = 'done' and delay_min = 5 and duration_ratio = 1.333 and postpone_count = 1;
  v_checks := v_checks + 1;
  if v_n <> 1 then v_fail := v_fail || 'facts row not as expected'::text; end if;
  perform public._edit_routine(v_alice, now(), v_routine, 'smoke', null, '{1,2,3,4,5,6,7}', '23:50', 15, 10,
                               public.jst_date(now()) + 1, 'smoke edit');
  select count(*) into v_n from public.routine_versions where routine_id = v_routine;
  v_checks := v_checks + 1;
  if v_n <> 2 then v_fail := v_fail || format('versions=%s', v_n); end if;
  select status into v_status from public.occurrences where id = v_occ;
  v_checks := v_checks + 1;
  if v_status <> 'done' then v_fail := v_fail || format('done occurrence changed to %s', v_status); end if;
  perform public._close_missed(v_alice, now() + interval '3 days');
  select count(*) into v_n from public.occurrences
   where user_id = v_alice and status in ('scheduled', 'notified', 'postponed');
  v_checks := v_checks + 1;
  if v_n <> 0 then v_fail := v_fail || format('open after close_missed=%s', v_n); end if;

  -- 5. 版の書き換えは DB の中でも拒否される
  v_err := null;
  begin
    update public.routine_versions set duration_min = 99 where routine_id = v_routine;
  exception when insufficient_privilege then
    v_err := 'denied';
  end;
  v_checks := v_checks + 1;
  if v_err is distinct from 'denied' then v_fail := v_fail || 'version update not denied'::text; end if;

  -- 6. 通知ジョブは作られていない（Phase 1 では作らない。送信は起きない）
  select count(*) into v_n from public.notification_jobs where user_id in (v_alice, v_bob);
  v_checks := v_checks + 1;
  if v_n <> 0 then v_fail := v_fail || format('notification_jobs=%s', v_n); end if;

  -- 最後に必ず例外を出して、ここまでのすべてを取り消す
  if cardinality(v_fail) = 0 then
    raise exception 'SMOKE_OK checks=% (rolled back)', v_checks;
  else
    raise exception 'SMOKE_NG checks=% failures=% (rolled back)', v_checks, array_to_string(v_fail, '; ');
  end if;
end;
$smoke$;
