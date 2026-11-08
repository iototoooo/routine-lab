-- =====================================================================
-- Phase 2：送信側の関数（send-push から service_role で呼ぶ。docs/phase2-plan.md 2〜4章）
--   - claim_due_jobs：送る直前に予定の状態を確かめ、確定済み・時刻がずれた通知は送らずに取り消す
--   - job_payloads：通知の文面に使う予定の情報（ルーティン名は予定を作った版の名前）
--   - finish_job：1台以上の Push サービスが受け付けたら成功。予定時刻の通知なら予定を「通知済み」にし、
--                イベント notified を残す（受け付け＝端末での表示ではない。detail に accepted_devices を記録）
--   - retry_job：5xx・通信エラーだけのときは、期限内で最大3回まで次の分に再送（判断事項3。最初の送信と合わせて最大4回）
--   - cancel_job：送る直前に予定が確定していた場合に、送らずに取り消す
-- 時刻に依存する処理は内部の関数（_xxx、p_now を受け取る）に分け、テストで時刻を指定できるようにする。
-- =====================================================================

-- 予定とジョブが今も合っているか（送ってよいか）
create function public._job_still_due(p_kind text, p_fire_at timestamptz, p_occ public.occurrences)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_kind = 'test' then true
    when p_occ.id is null then false
    when p_kind = 'initial' then p_occ.status = 'scheduled' and p_occ.planned_start_at = p_fire_at
    when p_kind = 'snooze' then p_occ.status = 'postponed' and p_occ.next_remind_at = p_fire_at
    else false
  end
$$;

-- ---------------------------------------------------------------------
-- 送る時刻になったジョブを取り出す
-- ---------------------------------------------------------------------
create function public._claim_due_jobs(p_now timestamptz, p_limit integer)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 送信途中で止まったジョブ（5分以上 sending）を戻す。3回試したら failed
  update public.notification_jobs
     set status = case when attempts >= 3 then 'failed' else 'pending' end,
         locked_at = null,
         last_error = coalesce(last_error, 'stale sending')
   where status = 'sending' and locked_at < p_now - interval '5 minutes';

  -- 期限切れ（通知時刻から60分）は送らない（F-307）
  update public.notification_jobs
     set status = 'expired'
   where status = 'pending' and expires_at <= p_now;

  -- 予定が確定した・時刻がずれた通知は送らない（トリガーの取り消しに加えた二重の守り）
  update public.notification_jobs j
     set status = 'cancelled', cancel_reason = 'stale', cancelled_at = p_now
    from public.occurrences o
   where j.occurrence_id = o.id
     and j.status = 'pending'
     and j.fire_at <= p_now
     and not public._job_still_due(j.kind, j.fire_at, o);

  return query
  with due as (
    select j.id from public.notification_jobs j
     where j.status = 'pending' and j.fire_at <= p_now and j.expires_at > p_now
     order by j.fire_at
     limit greatest(1, least(coalesce(p_limit, 50), 100))
     for update of j skip locked
  )
  update public.notification_jobs j
     set status = 'sending', locked_at = p_now, attempts = j.attempts + 1
    from due
   where j.id = due.id
  returning j.*;
end;
$$;

create or replace function public.claim_due_jobs(p_limit integer default 50)
returns setof public.notification_jobs
language sql
security definer
set search_path = ''
as $$
  select * from public._claim_due_jobs(now(), p_limit)
$$;

-- ---------------------------------------------------------------------
-- 通知の文面に使う予定の情報（取り出したジョブの分だけ）
-- ---------------------------------------------------------------------
create function public.job_payloads(p_job_ids uuid[])
returns table (
  job_id uuid,
  occurrence_id uuid,
  kind text,
  routine_name text,
  planned_start_at timestamptz,
  planned_duration_min integer,
  postpone_count integer,
  occurrence_status text,
  still_due boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, o.id, j.kind, v.name, o.planned_start_at, o.planned_duration_min, o.postpone_count, o.status,
         public._job_still_due(j.kind, j.fire_at, o)
    from public.notification_jobs j
    join public.occurrences o on o.id = j.occurrence_id
    join public.routine_versions v on v.id = o.routine_version_id
   where j.id = any (p_job_ids)
$$;

-- ---------------------------------------------------------------------
-- 送信の結果
-- ---------------------------------------------------------------------
create function public._finish_job(p_now timestamptz, p_job_id uuid, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.notification_jobs;
  v_occ public.occurrences;
  v_accepted integer;
begin
  update public.notification_jobs
     set status = case when p_ok then 'sent' else 'failed' end,
         sent_at = case when p_ok then p_now else null end,
         last_error = left(p_error, 200),
         locked_at = null
   where id = p_job_id and status = 'sending'
  returning * into v_job;

  if v_job.id is null or not p_ok or v_job.occurrence_id is null then
    return;
  end if;

  select * into v_occ from public.occurrences where id = v_job.occurrence_id for update;
  if v_occ.id is null then
    return;
  end if;

  select count(*) into v_accepted
    from public.notification_deliveries
   where job_id = v_job.id and ok;

  -- 通知の事実を残す（受け付けた端末の数・その時点の予定の状態。完了と同時に送られた場合も分かる）
  insert into public.occurrence_events
    (user_id, occurrence_id, type, from_status, to_status, actor, detail, created_at)
  values (v_occ.user_id, v_occ.id, 'notified', v_occ.status,
          case when v_job.kind = 'initial' and v_occ.status = 'scheduled' then 'notified' else v_occ.status end,
          'system',
          jsonb_build_object('kind', v_job.kind, 'job_id', v_job.id, 'fire_at', v_job.fire_at,
                             'attempts', v_job.attempts, 'accepted_devices', v_accepted),
          p_now);

  if v_job.kind = 'initial' and v_occ.status = 'scheduled' then
    update public.occurrences
       set status = 'notified', updated_at = p_now
     where id = v_occ.id;
  end if;
end;
$$;

create or replace function public.finish_job(p_job_id uuid, p_ok boolean, p_error text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  select public._finish_job(now(), p_job_id, p_ok, p_error)
$$;

-- 一時的な失敗（5xx・通信エラー）だけのとき：期限内で3回までは送信待ちに戻す（最初の送信と合わせて最大4回）。それ以外は failed
create function public._retry_job(p_now timestamptz, p_job_id uuid, p_error text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  update public.notification_jobs
     set status = case when attempts < 4 and expires_at > p_now then 'pending' else 'failed' end,
         last_error = left(p_error, 200),
         locked_at = null
   where id = p_job_id and status = 'sending'
  returning status into v_status;
  return coalesce(case when v_status = 'pending' then 'retry' else v_status end, 'not_sending');
end;
$$;

create function public.retry_job(p_job_id uuid, p_error text default null)
returns text
language sql
security definer
set search_path = ''
as $$
  select public._retry_job(now(), p_job_id, p_error)
$$;

-- 送る直前に予定が確定していた（送らない）
create function public._cancel_job(p_now timestamptz, p_job_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.notification_jobs
     set status = 'cancelled', cancel_reason = 'stale', cancelled_at = p_now, locked_at = null
   where id = p_job_id and status = 'sending'
$$;

create function public.cancel_job(p_job_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select public._cancel_job(now(), p_job_id)
$$;

-- ---------------------------------------------------------------------
-- 権限：画面（anon / authenticated）からは使えない。送信用の入口は service_role だけ
-- ---------------------------------------------------------------------
revoke all on function public._job_still_due(text, timestamptz, public.occurrences) from public, anon, authenticated;
revoke all on function public._claim_due_jobs(timestamptz, integer) from public, anon, authenticated;
revoke all on function public._finish_job(timestamptz, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public._retry_job(timestamptz, uuid, text) from public, anon, authenticated;
revoke all on function public._cancel_job(timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.job_payloads(uuid[]) from public, anon, authenticated;
revoke all on function public.retry_job(uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_job(uuid) from public, anon, authenticated;
revoke all on function public.claim_due_jobs(integer) from public, anon, authenticated;
revoke all on function public.finish_job(uuid, boolean, text) from public, anon, authenticated;

grant execute on function public.claim_due_jobs(integer) to service_role;
grant execute on function public.finish_job(uuid, boolean, text) to service_role;
grant execute on function public.job_payloads(uuid[]) to service_role;
grant execute on function public.retry_job(uuid, text) to service_role;
grant execute on function public.cancel_job(uuid) to service_role;
