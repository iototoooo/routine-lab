-- =====================================================================
-- Phase 4：改善提案の承認・却下（docs/phase4-plan.md 3章、要件 F-601〜604・6.1 節）
--
-- 1. 表 suggestions：承認・却下の判断を1件1行で記録する（作成後は変更・削除できない）
--    - 提案そのものは画面を開いたときに画面側で計算する（src/lib/suggestions/）。保存するのは判断したときだけ
-- 2. 版に「どの提案から作ったか」をつなぐ（routine_versions.suggestion_id の外部キー。Phase 1 で列だけ用意した）
-- 3. 版を追加する処理を、きっかけ（manual / suggestion）を受け取る内部関数 _apply_routine_version に移す
--    - _edit_routine（手動の編集）はそれを 'manual' で呼ぶだけにする。引数・動き・予定と通知の付け直しは今までと同じ
-- 4. RPC accept_suggestion / reject_suggestion
--    - 本人のルーティン・アーカイブしていない・テスト用でない・提案のもとにした版が今の版のまま、を DB で確かめる
--    - 同じルーティン・同じルールで 28 日以内に判断済みなら受け付けない（再提案しない期間。判断事項 4）
--    - 提案の設定は、ルールごとに変えてよい項目だけが変わっていることを確かめる（R-01 開始時刻・R-02 曜日・R-03 所要時間）
-- 予定・実績・イベント・通知ジョブの既存の行、cron、Edge Function、通知の送信の仕組みは変えない。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 判断の記録
-- ---------------------------------------------------------------------
create table public.suggestions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  routine_id         uuid not null,
  rule_id            text not null check (rule_id in ('R-01', 'R-02', 'R-03')),
  base_version_id    uuid not null,
  evidence           jsonb not null check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 8000),
  current_settings   jsonb not null check (jsonb_typeof(current_settings) = 'object'),
  proposed           jsonb not null check (jsonb_typeof(proposed) = 'object'),
  status             text not null check (status in ('accepted', 'rejected')),
  decided_at         timestamptz not null,
  applied_version_id uuid,
  created_at         timestamptz not null default now(),
  constraint suggestions_routine_fk
    foreign key (routine_id, user_id) references public.routines (id, user_id) on delete cascade,
  constraint suggestions_base_version_fk
    foreign key (base_version_id, routine_id) references public.routine_versions (id, routine_id) on delete cascade,
  constraint suggestions_applied_version_fk
    foreign key (applied_version_id, routine_id) references public.routine_versions (id, routine_id) on delete cascade,
  -- 承認だけが版を作る（却下は版を作らない）
  constraint suggestions_applied check ((status = 'accepted') = (applied_version_id is not null)),
  constraint suggestions_applied_once unique (applied_version_id),
  -- 同じ版・同じルールの判断は1回だけ（二重の承認・承認と却下の両方を防ぐ）
  constraint suggestions_once_per_version unique (base_version_id, rule_id)
);
create index suggestions_by_routine on public.suggestions (routine_id, rule_id, decided_at desc);
create index suggestions_by_user on public.suggestions (user_id, decided_at desc);

alter table public.suggestions enable row level security;
revoke all on public.suggestions from public, anon, authenticated;
grant select on public.suggestions to authenticated;
create policy suggestions_select_own on public.suggestions
  for select to authenticated using (user_id = (select auth.uid()));

-- 作成後は変更・削除させない（版・実績・イベントと同じ守り。アカウント削除の連鎖だけは通る）
create trigger suggestions_guard before update or delete on public.suggestions
  for each row execute function public.guard_history();

-- ---------------------------------------------------------------------
-- 2. 版と提案をつなぐ
--    版を先に作り、同じトランザクションの中で提案の行を入れるため、外部キーは終わりに確かめる（deferrable）
-- ---------------------------------------------------------------------
alter table public.routine_versions
  add constraint routine_versions_suggestion_fk
    foreign key (suggestion_id) references public.suggestions (id) deferrable initially deferred,
  add constraint routine_versions_source_suggestion
    check ((source = 'suggestion') = (suggestion_id is not null));

-- ---------------------------------------------------------------------
-- 3. 版を追加する処理（_edit_routine の本体を移し、きっかけを受け取れるようにする）
--    本文は 20261108000200_phase2_edit_fix.sql の _edit_routine と同じ。違いは source・suggestion_id を入れることだけ
-- ---------------------------------------------------------------------
create function public._apply_routine_version(
  p_user uuid, p_now timestamptz, p_routine_id uuid,
  p_name text, p_note text, p_weekdays integer[], p_start_time time,
  p_duration_min integer, p_snooze_min integer,
  p_valid_from date, p_change_reason text,
  p_source text, p_suggestion_id uuid
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
  if p_source is null or p_source not in ('manual', 'suggestion')
     or (p_source = 'suggestion') <> (p_suggestion_id is not null) then
    raise exception 'invalid_input' using errcode = '22023';
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
     valid_from, change_reason, source, suggestion_id, created_at)
  values
    (p_user, p_routine_id, v_cur.version_no + 1, v_name, v_note, v_weekdays, p_start_time,
     p_duration_min, p_snooze_min, p_valid_from, v_reason, p_source, p_suggestion_id, p_now)
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

-- 手動の編集：引数と動きは今までと同じ（きっかけ = manual）
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
begin
  return public._apply_routine_version(p_user, p_now, p_routine_id, p_name, p_note, p_weekdays, p_start_time,
                                       p_duration_min, p_snooze_min, p_valid_from, p_change_reason, 'manual', null);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. 承認・却下
-- ---------------------------------------------------------------------
-- 判断の前の共通の確認。今の版（行ロック済み）と、提案の設定（曜日・開始時刻・所要時間）を返す
create function public._check_suggestion(
  p_user uuid, p_now timestamptz, p_routine_id uuid, p_rule_id text, p_base_version_id uuid,
  p_evidence jsonb, p_proposed jsonb,
  out o_cur public.routine_versions, out o_weekdays smallint[], out o_start time, out o_duration integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_routine public.routines;
  v_start text;
  v_dur jsonb;
begin
  if p_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_rule_id is null or p_rule_id not in ('R-01', 'R-02', 'R-03')
     or p_evidence is null or jsonb_typeof(p_evidence) <> 'object' or octet_length(p_evidence::text) > 8000
     or p_proposed is null or jsonb_typeof(p_proposed) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- ルーティンの行をロックして、同時の承認・却下・編集を1つずつ処理する
  select * into v_routine from public.routines
   where id = p_routine_id and user_id = p_user
   for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_routine.archived_at is not null then
    raise exception 'routine_archived' using errcode = '22023';
  end if;
  if v_routine.exclude_from_analytics then
    raise exception 'routine_excluded' using errcode = '22023';
  end if;
  select * into o_cur from public.routine_versions
   where routine_id = p_routine_id and valid_to is null;
  if not found or o_cur.id is distinct from p_base_version_id then
    raise exception 'stale_suggestion' using errcode = '40001';
  end if;
  -- 同じルーティン・同じルールで、28 日以内（JST の日付）に判断していれば受け付けない
  if exists (
    select 1 from public.suggestions s
     where s.routine_id = p_routine_id and s.rule_id = p_rule_id
       and (s.base_version_id = p_base_version_id
            or public.jst_date(s.decided_at) > public.jst_date(p_now) - 28)
  ) then
    raise exception 'recently_decided' using errcode = '22023';
  end if;

  -- 提案の設定を読む（形が違えば invalid_input）
  if jsonb_typeof(p_proposed -> 'weekdays') <> 'array'
     or jsonb_typeof(p_proposed -> 'start_time') <> 'string'
     or jsonb_typeof(p_proposed -> 'duration_min') <> 'number'
     or exists (select 1 from jsonb_array_elements(p_proposed -> 'weekdays') x where jsonb_typeof(x) <> 'number') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_start := p_proposed ->> 'start_time';
  v_dur := p_proposed -> 'duration_min';
  if v_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (v_dur #>> '{}') !~ '^[0-9]{1,3}$' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  o_start := v_start::time;
  o_duration := (v_dur #>> '{}')::integer;
  o_weekdays := public._normalize_weekdays(
    array(select (x #>> '{}')::numeric::integer from jsonb_array_elements(p_proposed -> 'weekdays') x));
  if jsonb_array_length(p_proposed -> 'weekdays') <> coalesce(array_length(o_weekdays, 1), 0)
     or not public.is_valid_weekdays(o_weekdays)
     or extract(minute from o_start)::integer % 5 <> 0
     or o_duration not between 5 and 480 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  -- ルールごとに、変えてよい項目だけが変わっていること
  if p_rule_id = 'R-01' then
    -- 開始時刻を遅らせる（同じ日の中で）。曜日・所要時間は同じ
    if not (o_weekdays = o_cur.weekdays and o_duration = o_cur.duration_min and o_start > o_cur.start_time) then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
  elsif p_rule_id = 'R-02' then
    -- 曜日を1つ外す（残りは今の曜日の一部で、1つ以上）。開始時刻・所要時間は同じ
    if not (o_start = o_cur.start_time and o_duration = o_cur.duration_min
            and o_weekdays <@ o_cur.weekdays
            and array_length(o_weekdays, 1) = array_length(o_cur.weekdays, 1) - 1) then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
  else
    -- R-03：所要時間を延ばす。曜日・開始時刻は同じ
    if not (o_weekdays = o_cur.weekdays and o_start = o_cur.start_time and o_duration > o_cur.duration_min) then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
  end if;
end;
$$;

create function public._settings_json(v public.routine_versions)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('weekdays', to_jsonb(v.weekdays), 'start_time', to_char(v.start_time, 'HH24:MI'),
                            'duration_min', v.duration_min)
$$;

create function public._accept_suggestion(
  p_user uuid, p_now timestamptz, p_routine_id uuid, p_rule_id text, p_base_version_id uuid,
  p_evidence jsonb, p_proposed jsonb, p_valid_from date, p_change_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  v_id uuid := gen_random_uuid();
  v_new uuid;
begin
  select * into c from public._check_suggestion(p_user, p_now, p_routine_id, p_rule_id, p_base_version_id, p_evidence, p_proposed);
  -- 版の追加は手動の編集と同じ処理（予定・通知の付け直しも同じ）。名前・メモ・再通知は今の版のまま
  v_new := public._apply_routine_version(
    p_user, p_now, p_routine_id, (c.o_cur).name, (c.o_cur).note, c.o_weekdays::integer[], c.o_start,
    c.o_duration, (c.o_cur).snooze_min, p_valid_from, p_change_reason, 'suggestion', v_id);
  insert into public.suggestions
    (id, user_id, routine_id, rule_id, base_version_id, evidence, current_settings, proposed, status, decided_at,
     applied_version_id, created_at)
  values
    (v_id, p_user, p_routine_id, p_rule_id, p_base_version_id, p_evidence, public._settings_json(c.o_cur),
     jsonb_build_object('weekdays', to_jsonb(c.o_weekdays), 'start_time', to_char(c.o_start, 'HH24:MI'),
                        'duration_min', c.o_duration),
     'accepted', p_now, v_new, p_now);
  return v_new;
end;
$$;

create function public._reject_suggestion(
  p_user uuid, p_now timestamptz, p_routine_id uuid, p_rule_id text, p_base_version_id uuid,
  p_evidence jsonb, p_proposed jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  v_id uuid;
begin
  select * into c from public._check_suggestion(p_user, p_now, p_routine_id, p_rule_id, p_base_version_id, p_evidence, p_proposed);
  -- 版・予定・通知には触れない。判断だけを記録する
  insert into public.suggestions
    (user_id, routine_id, rule_id, base_version_id, evidence, current_settings, proposed, status, decided_at, created_at)
  values
    (p_user, p_routine_id, p_rule_id, p_base_version_id, p_evidence, public._settings_json(c.o_cur),
     jsonb_build_object('weekdays', to_jsonb(c.o_weekdays), 'start_time', to_char(c.o_start, 'HH24:MI'),
                        'duration_min', c.o_duration),
     'rejected', p_now, p_now)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.accept_suggestion(
  p_routine_id uuid, p_rule_id text, p_base_version_id uuid, p_evidence jsonb, p_proposed jsonb,
  p_valid_from date, p_change_reason text
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select public._accept_suggestion((select auth.uid()), now(), p_routine_id, p_rule_id, p_base_version_id,
                                   p_evidence, p_proposed, p_valid_from, p_change_reason)
$$;

create function public.reject_suggestion(
  p_routine_id uuid, p_rule_id text, p_base_version_id uuid, p_evidence jsonb, p_proposed jsonb
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select public._reject_suggestion((select auth.uid()), now(), p_routine_id, p_rule_id, p_base_version_id,
                                   p_evidence, p_proposed)
$$;

revoke all on function
  public._apply_routine_version(uuid, timestamptz, uuid, text, text, integer[], time, integer, integer, date, text, text, uuid),
  public._check_suggestion(uuid, timestamptz, uuid, text, uuid, jsonb, jsonb),
  public._settings_json(public.routine_versions),
  public._accept_suggestion(uuid, timestamptz, uuid, text, uuid, jsonb, jsonb, date, text),
  public._reject_suggestion(uuid, timestamptz, uuid, text, uuid, jsonb, jsonb),
  public.accept_suggestion(uuid, text, uuid, jsonb, jsonb, date, text),
  public.reject_suggestion(uuid, text, uuid, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function
  public.accept_suggestion(uuid, text, uuid, jsonb, jsonb, date, text),
  public.reject_suggestion(uuid, text, uuid, jsonb, jsonb)
to authenticated;
