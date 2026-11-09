-- =====================================================================
-- Phase 4 の取り消し（マイグレーション 20261110000000 を元に戻し、Phase 3 の状態にする）
--
-- 使うのは、Phase 4 の反映後に重大な問題が見つかり、Phase 3 の状態へ戻すと決めたときだけ（非常用）。
-- ふだん「承認した提案を元に戻す」ときは、これではなく画面から元の設定で新しい版を作る（docs/phase4-plan.md 3.3 節）。
-- 実行は承認後のみ：npx supabase db query --remote=<ref> -f supabase/rollback/20261110_phase4_down.sql --yes
--
-- - 予定・実績・版・イベント・通知ジョブの行は消さない。
-- - 判断記録・提案から作った版が1件でもあれば、下の安全チェックで止まる（記録は失わない）。
--   0件のときだけ実行されるので、失われるデータはない。
-- - _edit_routine は Phase 2 の定義（20261108000200_phase2_edit_fix.sql の本文そのまま）に戻す。
-- - 画面（Cloudflare Pages）も Phase 3 のコミットに戻すこと（提案・比較・書き出しの画面が新しい表と RPC を使うため）。
-- 全体を1つのトランザクションで行う。tests/db/rollback.test.ts で、Phase 3 だけの状態と同じになることを確かめている。
--
-- 安全チェック（最初に行う。どちらかに当てはまれば、何も変えずにエラーで止まる）：
--   1. 判断記録（suggestions）が1件以上ある
--   2. 提案から作った版（routine_versions の source = 'suggestion' または suggestion_id あり）が1件以上ある
--   判断記録を消すと「なぜ設定を変えたか」の履歴が失われ、版が消えた記録を指したまま残り、Phase 4 を再適用できなくなるため。
--   記録がある状態で戻す必要が出たら、この SQL は使わず、改めて手順を相談する（先に JSON で書き出して保存する、など）。
--   止まったときはトランザクションが失敗状態になり、接続を閉じれば（または rollback で）すべて取り消される。
-- =====================================================================
begin;

do $check$
declare
  v_decisions bigint := 0;
  v_versions bigint;
begin
  if to_regclass('public.suggestions') is not null then
    execute 'select count(*) from public.suggestions' into v_decisions;
  end if;
  select count(*) into v_versions from public.routine_versions
   where source = 'suggestion' or suggestion_id is not null;
  if v_decisions > 0 or v_versions > 0 then
    raise exception 'PHASE4_ROLLBACK_REFUSED: 改善提案の判断記録 % 件・提案から作った版 % 件があるため、取り消しを中止しました（何も変更していません）', v_decisions, v_versions
      using errcode = 'P0001',
            hint = '判断記録を消すと設定変更の履歴が失われ、Phase 4 を再適用できなくなります。docs/phase4-plan.md の取り消しの節を参照し、手順を相談してください。';
  end if;
end;
$check$;

drop function if exists public.accept_suggestion(uuid, text, uuid, jsonb, jsonb, date, text);
drop function if exists public.reject_suggestion(uuid, text, uuid, jsonb, jsonb);
drop function if exists public._accept_suggestion(uuid, timestamptz, uuid, text, uuid, jsonb, jsonb, date, text);
drop function if exists public._reject_suggestion(uuid, timestamptz, uuid, text, uuid, jsonb, jsonb);
drop function if exists public._check_suggestion(uuid, timestamptz, uuid, text, uuid, jsonb, jsonb);
drop function if exists public._settings_json(public.routine_versions);

-- Phase 2 の定義に戻す（20261108000200_phase2_edit_fix.sql の本文そのまま）
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

drop function if exists public._apply_routine_version(uuid, timestamptz, uuid, text, text, integer[], time, integer, integer, date, text, text, uuid);

alter table public.routine_versions drop constraint if exists routine_versions_source_suggestion;
alter table public.routine_versions drop constraint if exists routine_versions_suggestion_fk;
drop table if exists public.suggestions;

delete from supabase_migrations.schema_migrations where version = '20261110000000';

commit;
