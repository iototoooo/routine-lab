-- =====================================================================
-- Phase 1：書き込み用の関数（docs/phase1-plan.md 2.2 節）
--
-- 構成
--   - 画面から呼ぶ関数（create_routine など）は薄い入口。auth.uid() と now() を決めて、内部の関数（_ で始まる）を呼ぶ
--   - 内部の関数は「利用者」と「今の時刻」を引数で受け取る。テストで時刻を自由に決められるようにするため
--     （本番の時刻を差し替える仕組みは作らない）。内部の関数は画面からは実行できない
--   - すべて security definer ＋ search_path = ''。所有者のチェックは内部の関数の冒頭で必ず行う
--
-- エラーは英語の短いコード（message）で返し、画面側（src/lib/data/errors.ts）で日本語にする
--   not_authenticated / not_found / invalid_input / routine_limit / routine_archived / no_change /
--   invalid_valid_from / occurrence_closed / deadline_passed / invalid_start / invalid_remind_at / reason_required
--
-- 判断事項（2026-11-07 承認）
--   1. 開始時刻を過ぎてから登録・編集した場合、その日の予定は作らない（予定の開始 > 版の作成時刻 のときだけ作る）
--   2. アーカイブ時、開始時刻を過ぎた未記録の予定は残す。まだ始まっていない予定は取り消す
--   4. Phase 1 では通知ジョブを作らない（延期の時刻は next_remind_at とイベントに保存し、Phase 2 でつなぐ）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 日本時間の計算（日本はサマータイムがないので常に +9 時間。src/lib/time/jst.ts と同じ定義）
-- ---------------------------------------------------------------------
create function public.jst_date(p_at timestamptz)
returns date
language sql
immutable
set search_path = ''
as $$ select (p_at at time zone 'Asia/Tokyo')::date $$;

create function public.jst_instant(p_date date, p_time time)
returns timestamptz
language sql
immutable
set search_path = ''
as $$ select (p_date + p_time) at time zone 'Asia/Tokyo' $$;

-- 記録の期限：予定日の翌日の終わり（＝予定日＋2日の 0:00 JST。F-406）
create function public.occurrence_deadline(p_planned_date date)
returns timestamptz
language sql
immutable
set search_path = ''
as $$ select public.jst_instant(p_planned_date + 2, time '00:00') $$;

-- 入力の名前・メモ・曜日を整える（前後の空白を除く、曜日は昇順・重複なし）
create function public._normalize_weekdays(p integer[])
returns smallint[]
language sql
immutable
set search_path = ''
as $$ select array(select distinct x::smallint from unnest(p) as u(x) where x is not null order by 1) $$;

-- ---------------------------------------------------------------------
-- 予定の作成（F-201〜203）。何度呼んでも重複しない（一意制約＋on conflict do nothing）
--   p_user が null なら全員分（cron 用）
-- ---------------------------------------------------------------------
create function public._ensure_occurrences(p_user uuid, p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.jst_date(p_now);
  v_count integer;
begin
  insert into public.occurrences
    (user_id, routine_id, routine_version_id, planned_date, planned_start_at, planned_duration_min,
     created_at, updated_at)
  select r.user_id, r.id, v.id, d.day, public.jst_instant(d.day, v.start_time), v.duration_min, p_now, p_now
    from (values (v_today), (v_today + 1)) as d(day)
    join public.routine_versions v
      on v.valid_from <= d.day and (v.valid_to is null or d.day < v.valid_to)
    join public.routines r
      on r.id = v.routine_id and r.archived_at is null
   where (p_user is null or r.user_id = p_user)
     and extract(isodow from d.day)::smallint = any (v.weekdays)
     -- 判断事項1：版を作った時点で開始時刻を過ぎていた予定は作らない
     and public.jst_instant(d.day, v.start_time) > v.created_at
  on conflict (routine_id, planned_date) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- 未実施の確定（F-406）：予定日の翌日の終わりを過ぎても未確定なら missed
-- ---------------------------------------------------------------------
create function public._close_missed(p_user uuid, p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with target as (
    select o.id, o.user_id, o.status
      from public.occurrences o
     where o.status in ('scheduled', 'notified', 'postponed')
       and public.occurrence_deadline(o.planned_date) <= p_now
       and (p_user is null or o.user_id = p_user)
     for update
  ), upd as (
    update public.occurrences o
       set status = 'missed', closed_at = p_now, next_remind_at = null, updated_at = p_now
      from target t
     where o.id = t.id
    returning o.id
  )
  insert into public.occurrence_events (user_id, occurrence_id, type, from_status, to_status, actor, created_at)
  select t.user_id, t.id, 'missed', t.status, 'missed', 'system', p_now
    from target t join upd u on u.id = t.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- ルーティンの登録（F-101）
-- ---------------------------------------------------------------------
create function public._create_routine(
  p_user uuid, p_now timestamptz,
  p_name text, p_note text, p_weekdays integer[], p_start_time time,
  p_duration_min integer, p_snooze_min integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_routine uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_weekdays smallint[] := public._normalize_weekdays(p_weekdays);
begin
  if p_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 40
     or (v_note is not null and char_length(v_note) > 500)
     or not public.is_valid_weekdays(v_weekdays)
     or p_start_time is null
     or p_duration_min is null or p_duration_min not between 5 and 480
     or p_snooze_min is null or p_snooze_min not between 5 and 240 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- 1人あたりの上限（誤操作やいたずらで表が膨らまないように）
  if (select count(*) from public.routines where user_id = p_user and archived_at is null) >= 50 then
    raise exception 'routine_limit' using errcode = '22023';
  end if;

  insert into public.routines (user_id, name, note, created_at, updated_at)
  values (p_user, v_name, v_note, p_now, p_now)
  returning id into v_routine;

  insert into public.routine_versions
    (user_id, routine_id, version_no, name, note, weekdays, start_time, duration_min, snooze_min,
     valid_from, source, created_at)
  values
    (p_user, v_routine, 1, v_name, v_note, v_weekdays, p_start_time, p_duration_min, p_snooze_min,
     public.jst_date(p_now), 'manual', p_now);

  perform public._ensure_occurrences(p_user, p_now);
  return v_routine;
end;
$$;

-- ---------------------------------------------------------------------
-- ルーティンの編集（F-102）：新しい版を追加し、前の版の有効期間を閉じる
--   適用開始日以降の予定のうち「予定中・イベントなし・まだ始まっていない」ものだけ新しい版に合わせる。
--   新しい版でその日が対象外、または新しい開始時刻を過ぎている（判断事項1）なら取り消す。
--   通知済み・記録済み・開始時刻を過ぎた予定は、そのまま残す（P-01）
-- ---------------------------------------------------------------------
create function public._edit_routine(
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

-- ---------------------------------------------------------------------
-- アーカイブ（F-103）：以後の予定は作らない。まだ始まっていない未記録の予定は取り消す（判断事項2）
-- ---------------------------------------------------------------------
create function public._archive_routine(p_user uuid, p_now timestamptz, p_routine_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_routine public.routines;
  v_count integer;
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
  update public.routines set archived_at = p_now, updated_at = p_now where id = p_routine_id;

  with target as (
    select o.id, o.status from public.occurrences o
     where o.routine_id = p_routine_id
       and o.status in ('scheduled', 'notified', 'postponed')
       and o.planned_start_at > p_now
     for update
  ), upd as (
    update public.occurrences o
       set status = 'cancelled', closed_at = p_now, next_remind_at = null, updated_at = p_now
      from target t where o.id = t.id
    returning o.id
  )
  insert into public.occurrence_events
    (user_id, occurrence_id, type, from_status, to_status, actor, detail, created_at)
  select p_user, t.id, 'cancelled', t.status, 'cancelled', 'user', jsonb_build_object('cause', 'archived'), p_now
    from target t join upd u on u.id = t.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- 記録の共通部分：本人の、まだ確定していない、期限内の予定をロックして返す
-- ---------------------------------------------------------------------
create function public._lock_open_occurrence(p_user uuid, p_now timestamptz, p_occurrence_id uuid)
returns public.occurrences
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.occurrences;
begin
  if p_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v from public.occurrences
   where id = p_occurrence_id and user_id = p_user
   for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v.status not in ('scheduled', 'notified', 'postponed') then
    raise exception 'occurrence_closed' using errcode = '22023';
  end if;
  if public.occurrence_deadline(v.planned_date) <= p_now then
    raise exception 'deadline_passed' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
-- 完了（F-402, F-405）
--   実際の開始は「予定日の 0:00 JST 以降」かつ「今より後でない」。所要時間は 1〜1440 分
--   start_source：planned（予定時刻に開始）／now（今終わった＝開始は今−所要時間）／timer／manual
-- ---------------------------------------------------------------------
create function public._record_done(
  p_user uuid, p_now timestamptz, p_occurrence_id uuid,
  p_actual_start_at timestamptz, p_actual_duration_min integer, p_start_source text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.occurrences;
  v_exec uuid;
begin
  v := public._lock_open_occurrence(p_user, p_now, p_occurrence_id);
  if p_actual_duration_min is null or p_actual_duration_min not between 1 and 1440
     or p_start_source is null or p_start_source not in ('planned', 'now', 'timer', 'manual') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_actual_start_at is null
     or p_actual_start_at < public.jst_instant(v.planned_date, time '00:00')
     or p_actual_start_at > p_now + interval '1 minute' then
    raise exception 'invalid_start' using errcode = '22023';
  end if;

  insert into public.executions
    (user_id, occurrence_id, planned_date, actual_start_at, actual_end_at, actual_duration_min,
     executed_date, start_source, recorded_at)
  values
    (p_user, v.id, v.planned_date, date_trunc('minute', p_actual_start_at),
     date_trunc('minute', p_actual_start_at) + make_interval(mins => p_actual_duration_min),
     p_actual_duration_min, public.jst_date(date_trunc('minute', p_actual_start_at)), p_start_source, p_now)
  returning id into v_exec;

  update public.occurrences
     set status = 'done', closed_at = p_now, next_remind_at = null, updated_at = p_now
   where id = v.id;
  insert into public.occurrence_events
    (user_id, occurrence_id, type, from_status, to_status, execution_id, actor, created_at)
  values (p_user, v.id, 'done', v.status, 'done', v_exec, 'user', p_now);
  return v_exec;
end;
$$;

-- ---------------------------------------------------------------------
-- 延期（F-403）。予定時刻は変えず、再通知の時刻を決める
--   10m / 30m / 1h：今から。tomorrow_same：明日（JST）の予定と同じ時刻。today_at：今日（JST）の指定時刻（p_remind_at）
--   再通知の時刻は「今より後」かつ「期限（予定日の翌日の終わり）より前」
-- ---------------------------------------------------------------------
create function public._postpone(
  p_user uuid, p_now timestamptz, p_occurrence_id uuid,
  p_option text, p_remind_at timestamptz, p_reason_code text, p_reason_text text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.occurrences;
  v_remind timestamptz;
  v_text text := nullif(btrim(coalesce(p_reason_text, '')), '');
begin
  v := public._lock_open_occurrence(p_user, p_now, p_occurrence_id);
  if (p_reason_code is not null
      and p_reason_code not in ('no_time', 'tired', 'forgot', 'plans', 'sick', 'unmotivated', 'other'))
     or (v_text is not null and (p_reason_code is null or char_length(v_text) > 500)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  v_remind := case p_option
    when '10m' then date_trunc('minute', p_now) + interval '10 minutes'
    when '30m' then date_trunc('minute', p_now) + interval '30 minutes'
    when '1h' then date_trunc('minute', p_now) + interval '1 hour'
    when 'tomorrow_same' then public.jst_instant(public.jst_date(p_now) + 1,
                                                 (v.planned_start_at at time zone 'Asia/Tokyo')::time)
    when 'today_at' then
      case when p_remind_at is not null and public.jst_date(p_remind_at) = public.jst_date(p_now)
           then date_trunc('minute', p_remind_at) end
  end;
  if p_option is null or p_option not in ('10m', '30m', '1h', 'today_at', 'tomorrow_same') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v_remind is null or v_remind <= p_now or v_remind >= public.occurrence_deadline(v.planned_date) then
    raise exception 'invalid_remind_at' using errcode = '22023';
  end if;

  update public.occurrences
     set status = 'postponed', next_remind_at = v_remind, postpone_count = postpone_count + 1,
         updated_at = p_now
   where id = v.id;
  insert into public.occurrence_events
    (user_id, occurrence_id, type, from_status, to_status, remind_at, postpone_option,
     reason_code, reason_text, actor, created_at)
  values (p_user, v.id, 'postponed', v.status, 'postponed', v_remind, p_option,
          p_reason_code, v_text, 'user', p_now);
  return v_remind;
end;
$$;

-- ---------------------------------------------------------------------
-- 見送り（F-404）：理由（選択）は必須、自由記述は任意
-- ---------------------------------------------------------------------
create function public._skip(
  p_user uuid, p_now timestamptz, p_occurrence_id uuid, p_reason_code text, p_reason_text text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.occurrences;
  v_text text := nullif(btrim(coalesce(p_reason_text, '')), '');
begin
  v := public._lock_open_occurrence(p_user, p_now, p_occurrence_id);
  if p_reason_code is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_reason_code not in ('no_time', 'tired', 'forgot', 'plans', 'sick', 'unmotivated', 'other')
     or (v_text is not null and char_length(v_text) > 500) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  update public.occurrences
     set status = 'skipped', closed_at = p_now, next_remind_at = null, updated_at = p_now
   where id = v.id;
  insert into public.occurrence_events
    (user_id, occurrence_id, type, from_status, to_status, reason_code, reason_text, actor, created_at)
  values (p_user, v.id, 'skipped', v.status, 'skipped', p_reason_code, v_text, 'user', p_now);
end;
$$;

-- =====================================================================
-- 画面から呼ぶ入口（本人＝auth.uid()、時刻＝now() に固定）
-- =====================================================================
create function public.ensure_occurrences()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- cron が止まっていても、開いたときに正しく確定・作成する
  perform public._close_missed(v_user, now());
  return public._ensure_occurrences(v_user, now());
end;
$$;

create function public.create_routine(
  p_name text, p_note text, p_weekdays integer[], p_start_time time,
  p_duration_min integer, p_snooze_min integer
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select public._create_routine((select auth.uid()), now(), p_name, p_note, p_weekdays, p_start_time,
                                p_duration_min, p_snooze_min)
$$;

create function public.edit_routine(
  p_routine_id uuid, p_name text, p_note text, p_weekdays integer[], p_start_time time,
  p_duration_min integer, p_snooze_min integer, p_valid_from date, p_change_reason text
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select public._edit_routine((select auth.uid()), now(), p_routine_id, p_name, p_note, p_weekdays,
                              p_start_time, p_duration_min, p_snooze_min, p_valid_from, p_change_reason)
$$;

create function public.archive_routine(p_routine_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$ select public._archive_routine((select auth.uid()), now(), p_routine_id) $$;

create function public.record_done(
  p_occurrence_id uuid, p_actual_start_at timestamptz, p_actual_duration_min integer, p_start_source text
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select public._record_done((select auth.uid()), now(), p_occurrence_id, p_actual_start_at,
                             p_actual_duration_min, p_start_source)
$$;

create function public.postpone(
  p_occurrence_id uuid, p_option text, p_remind_at timestamptz, p_reason_code text, p_reason_text text
)
returns timestamptz
language sql
security definer
set search_path = ''
as $$
  select public._postpone((select auth.uid()), now(), p_occurrence_id, p_option, p_remind_at,
                          p_reason_code, p_reason_text)
$$;

create function public.skip_occurrence(p_occurrence_id uuid, p_reason_code text, p_reason_text text)
returns void
language sql
security definer
set search_path = ''
as $$ select public._skip((select auth.uid()), now(), p_occurrence_id, p_reason_code, p_reason_text) $$;

-- cron 用（全員分）。画面からは呼べない
create function public.ensure_occurrences_all()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._close_missed(null, now());
  return public._ensure_occurrences(null, now());
end;
$$;

create function public.close_missed()
returns integer
language sql
security definer
set search_path = ''
as $$ select public._close_missed(null, now()) $$;

-- =====================================================================
-- 実行権限：既定（PUBLIC と anon / authenticated への自動付与）をすべて外してから、入口だけ authenticated に許可
-- =====================================================================
revoke all on function
  public.jst_date(timestamptz),
  public.jst_instant(date, time),
  public.occurrence_deadline(date),
  public._normalize_weekdays(integer[]),
  public._ensure_occurrences(uuid, timestamptz),
  public._close_missed(uuid, timestamptz),
  public._create_routine(uuid, timestamptz, text, text, integer[], time, integer, integer),
  public._edit_routine(uuid, timestamptz, uuid, text, text, integer[], time, integer, integer, date, text),
  public._archive_routine(uuid, timestamptz, uuid),
  public._lock_open_occurrence(uuid, timestamptz, uuid),
  public._record_done(uuid, timestamptz, uuid, timestamptz, integer, text),
  public._postpone(uuid, timestamptz, uuid, text, timestamptz, text, text),
  public._skip(uuid, timestamptz, uuid, text, text),
  public.ensure_occurrences(),
  public.create_routine(text, text, integer[], time, integer, integer),
  public.edit_routine(uuid, text, text, integer[], time, integer, integer, date, text),
  public.archive_routine(uuid),
  public.record_done(uuid, timestamptz, integer, text),
  public.postpone(uuid, text, timestamptz, text, text),
  public.skip_occurrence(uuid, text, text),
  public.ensure_occurrences_all(),
  public.close_missed()
from public, anon, authenticated;

grant execute on function
  public.ensure_occurrences(),
  public.create_routine(text, text, integer[], time, integer, integer),
  public.edit_routine(uuid, text, text, integer[], time, integer, integer, date, text),
  public.archive_routine(uuid),
  public.record_done(uuid, timestamptz, integer, text),
  public.postpone(uuid, text, timestamptz, text, text),
  public.skip_occurrence(uuid, text, text)
to authenticated;
