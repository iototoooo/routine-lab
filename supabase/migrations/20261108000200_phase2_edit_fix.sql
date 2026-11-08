-- =====================================================================
-- Phase 2：編集による予定の作り直しの条件を直す（docs/phase2-plan.md 2章、要件 4.2）
--
-- 要件：「適用開始日以降の予定のうち、まだ通知も記録もされていないものは、作り直して新しい版に合わせる」。
-- Phase 1 の _edit_routine は「イベントが1つもない予定」だけを作り直していたため、同じ日に2回編集すると、
-- 1回目の編集で残した edited イベントのせいで2回目が反映されなかった（通知の時刻も古いままになる）。
-- 作り直さない条件を「edited 以外のイベント（通知・延期・記録など）がある」に改める。変更はこの1行だけ。
-- =====================================================================

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
       and not exists (select 1 from public.occurrence_events e where e.occurrence_id = o.id and e.type <> 'edited')
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
