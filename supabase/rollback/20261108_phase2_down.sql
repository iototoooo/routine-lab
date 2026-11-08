-- =====================================================================
-- Phase 2 の取り消し（マイグレーション 20261108000000〜000200 を元に戻し、Phase 1 の状態にする）
--
-- 使うのは、Phase 2 の反映後に重大な問題が見つかり、Phase 1 の状態へ戻すと決めたときだけ。
-- 実行は承認後のみ：npx supabase db query --remote=<ref> -f supabase/rollback/20261108_phase2_down.sql --yes
-- 送信を急いで止めるだけなら、こちらではなく node scripts/setup-cron-secret.mjs --off を使う。
--
-- - 送信待ちの予定の通知（initial / snooze）は取り消す（Phase 1 の send-push は予定の通知を送れないため）。
--   送信済み・取り消し済みの記録は消さない（取り消しの理由の列だけを外す）。
-- - claim_due_jobs / finish_job / _edit_routine は、Phase 0・Phase 1 の定義（元のファイルの本文）に戻す。
-- - send-push も Phase 1 時点の版を再デプロイすること（新しい send-push は Phase 1 の DB でも動くが、版を揃えるため）。
-- 全体を1つのトランザクションで行う。tests/db/rollback.test.ts で、Phase 1 だけの状態と同じになることを確かめている。
-- =====================================================================
begin;

drop trigger if exists occurrences_sync_jobs on public.occurrences;

update public.notification_jobs
   set status = 'cancelled', last_error = 'phase2 rollback', locked_at = null
 where kind in ('initial', 'snooze') and status in ('pending', 'sending');

-- Phase 0 の定義に戻す（20261105000000_phase0_push.sql の本文そのまま）
create or replace function public.claim_due_jobs(p_limit integer default 50)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 送信途中で止まったジョブ（5分以上 sending）を戻す。3回失敗したら failed
  update public.notification_jobs
     set status = case when attempts >= 3 then 'failed' else 'pending' end,
         locked_at = null,
         last_error = coalesce(last_error, 'stale sending')
   where status = 'sending' and locked_at < now() - interval '5 minutes';

  -- 期限切れ（予定時刻から60分など）は送らない（F-307）
  update public.notification_jobs
     set status = 'expired'
   where status = 'pending' and expires_at <= now();

  return query
  with due as (
    select id from public.notification_jobs
     where status = 'pending' and fire_at <= now() and expires_at > now()
     order by fire_at
     limit greatest(1, least(coalesce(p_limit, 50), 100))
     for update skip locked
  )
  update public.notification_jobs j
     set status = 'sending', locked_at = now(), attempts = j.attempts + 1
    from due
   where j.id = due.id
  returning j.*;
end;
$$;

create or replace function public.finish_job(p_job_id uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.notification_jobs
     set status = case when p_ok then 'sent' else 'failed' end,
         sent_at = case when p_ok then now() else null end,
         last_error = left(p_error, 200),
         locked_at = null
   where id = p_job_id and status = 'sending';
end;
$$;

-- Phase 1 の定義に戻す（20261107000200_phase1_rpc.sql の本文そのまま）
create or replace function public._edit_routine(
  p_user uuid, p_now timestamptz, p_routine_id uuid,
  p_name text, p_note text, p_weekdays integer[], p_start_time time,
  p_duration_min integer, p_snooze_min integer,
  p_valid_from date, p_change_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.jst_date(p_now);
  v_routine public.routines;
  v_cur public.routine_versions;
  v_new public.routine_versions;
  v_name text := btrim(coalesce(p_name, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_reason text := nullif(btrim(coalesce(p_change_reason, '')), '');
  v_weekdays smallint[] := public._normalize_weekdays(p_weekdays);
  r record;
  v_new_start timestamptz;
begin
  if p_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v_routine from public.routines
   where id = p_routine_id and user_id = p_user
   for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_routine.archived_at is not null then
    raise exception 'routine_archived' using errcode = '22023';
  end if;
  if char_length(v_name) not between 1 and 40
     or (v_note is not null and char_length(v_note) > 500)
     or not public.is_valid_weekdays(v_weekdays)
     or p_start_time is null
     or p_duration_min is null or p_duration_min not between 5 and 480
     or p_snooze_min is null or p_snooze_min not between 5 and 240
     or (v_reason is not null and char_length(v_reason) > 200) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  select * into v_cur from public.routine_versions
   where routine_id = p_routine_id and valid_to is null;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- 適用開始日：今日以降、今の版の開始日以降、1年以内
  if p_valid_from is null or p_valid_from < v_today or p_valid_from < v_cur.valid_from
     or p_valid_from > v_today + 365 then
    raise exception 'invalid_valid_from' using errcode = '22023';
  end if;
  if v_cur.name = v_name and v_cur.note is not distinct from v_note and v_cur.weekdays = v_weekdays
     and v_cur.start_time = p_start_time and v_cur.duration_min = p_duration_min
     and v_cur.snooze_min = p_snooze_min then
    raise exception 'no_change' using errcode = '22023';
  end if;

  update public.routine_versions set valid_to = p_valid_from where id = v_cur.id;
  insert into public.routine_versions
    (user_id, routine_id, version_no, name, note, weekdays, start_time, duration_min, snooze_min,
     valid_from, change_reason, source, created_at)
  values
    (p_user, p_routine_id, v_cur.version_no + 1, v_name, v_note, v_weekdays, p_start_time,
     p_duration_min, p_snooze_min, p_valid_from, v_reason, 'manual', p_now)
  returning * into v_new;
  update public.routines set name = v_name, note = v_note, updated_at = p_now where id = p_routine_id;

  for r in
    select o.* from public.occurrences o
     where o.routine_id = p_routine_id
       and o.planned_date >= p_valid_from
       and o.status = 'scheduled'
       and o.planned_start_at > p_now
       and not exists (select 1 from public.occurrence_events e where e.occurrence_id = o.id)
     order by o.planned_date
     for update
  loop
    v_new_start := public.jst_instant(r.planned_date, v_new.start_time);
    if extract(isodow from r.planned_date)::smallint = any (v_new.weekdays) and v_new_start > p_now then
      update public.occurrences
         set routine_version_id = v_new.id, planned_start_at = v_new_start,
             planned_duration_min = v_new.duration_min, updated_at = p_now
       where id = r.id;
      insert into public.occurrence_events
        (user_id, occurrence_id, type, from_status, to_status, actor, detail, created_at)
      values
        (p_user, r.id, 'edited', 'scheduled', 'scheduled', 'user',
         jsonb_build_object(
           'from', jsonb_build_object('routine_version_id', r.routine_version_id,
                                      'planned_start_at', r.planned_start_at,
                                      'planned_duration_min', r.planned_duration_min),
           'to', jsonb_build_object('routine_version_id', v_new.id,
                                    'planned_start_at', v_new_start,
                                    'planned_duration_min', v_new.duration_min)),
         p_now);
    else
      update public.occurrences
         set status = 'cancelled', closed_at = p_now, next_remind_at = null, updated_at = p_now
       where id = r.id;
      insert into public.occurrence_events
        (user_id, occurrence_id, type, from_status, to_status, actor, detail, created_at)
      values
        (p_user, r.id, 'cancelled', 'scheduled', 'cancelled', 'user',
         jsonb_build_object('cause', 'edited', 'routine_version_id', v_new.id), p_now);
    end if;
  end loop;

  perform public._ensure_occurrences(p_user, p_now);
  return v_new.id;
end;
$$;

drop function if exists
  public.job_payloads(uuid[]), public.retry_job(uuid, text), public.cancel_job(uuid),
  public._claim_due_jobs(timestamptz, integer), public._finish_job(timestamptz, uuid, boolean, text),
  public._retry_job(timestamptz, uuid, text), public._cancel_job(timestamptz, uuid),
  public.occurrences_sync_jobs(), public._sync_occurrence_jobs(public.occurrences, timestamptz),
  public._job_still_due(text, timestamptz, public.occurrences);

drop index if exists public.notification_jobs_by_occurrence;
alter table public.notification_jobs
  drop constraint if exists notification_jobs_cancel_reason,
  drop column if exists cancel_reason,
  drop column if exists cancelled_at;

delete from supabase_migrations.schema_migrations
 where version in ('20261108000000', '20261108000100', '20261108000200');

commit;
