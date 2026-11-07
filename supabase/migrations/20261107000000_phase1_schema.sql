-- =====================================================================
-- Phase 1：ルーティン・版・予定・実績・イベントの表（docs/phase1-plan.md 2章、要件 6.1 節）
--
-- 守ること（要件 2章）
--   P-01 履歴を上書きしない：版は作成後に変えない。予定には作成時の版の設定を写す。
--        実績・イベントは追記だけ（実績の修正は新しい行＋superseded_by）。
--   P-02 3種類の時刻を別の列で持つ：予定（occurrences.planned_start_at）／
--        再通知（occurrences.next_remind_at・occurrence_events.remind_at、通知ジョブは Phase 2）／
--        実行（executions.actual_start_at / actual_end_at）
--   P-03 失敗も記録する：見送り・延期・未実施を削除しない
--   P-05 日付と曜日は Asia/Tokyo で判定し、時刻は timestamptz（UTC）で保存する
-- 書き込みはすべて RPC（20261107000200）。この表の権限と RLS は 20261107000100。
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------
-- 共通：曜日の配列（ISO 1=月 … 7=日、1つ以上、昇順で重複なし）
-- ---------------------------------------------------------------------
create function public.is_valid_weekdays(p smallint[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
     and cardinality(p) between 1 and 7
     and array_position(p, null) is null
     and p = array(select distinct x from unnest(p) as u(x) order by x)
     and p <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
$$;

-- ---------------------------------------------------------------------
-- routines：ルーティンの基本情報（今の名前・メモ）。削除は archived_at（F-103）
-- ---------------------------------------------------------------------
create table public.routines (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40 and name = btrim(name)),
  note        text check (note is null or char_length(note) <= 500),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint routines_id_user unique (id, user_id)
);
create index routines_by_user on public.routines (user_id) where archived_at is null;

-- ---------------------------------------------------------------------
-- routine_versions：設定の版（F-101, F-102, F-105）。作成後は変更しない
--   有効期間は [valid_from, valid_to)。valid_to が null なら現在の版。
--   valid_from と valid_to が同じ日なら「一度も有効にならなかった版」（同じ日に2回編集したとき）。
--   名前・メモも写しておく（変更履歴で、その時点の名前を表示するため）
-- ---------------------------------------------------------------------
create table public.routine_versions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  routine_id    uuid not null,
  version_no    integer not null check (version_no >= 1),
  name          text not null check (char_length(name) between 1 and 40 and name = btrim(name)),
  note          text check (note is null or char_length(note) <= 500),
  weekdays      smallint[] not null check (public.is_valid_weekdays(weekdays)),
  start_time    time not null
                check (extract(second from start_time) = 0 and extract(minute from start_time)::integer % 5 = 0),
  duration_min  integer not null check (duration_min between 5 and 480),
  snooze_min    integer not null check (snooze_min between 5 and 240),
  valid_from    date not null,
  valid_to      date check (valid_to is null or valid_to >= valid_from),
  change_reason text check (change_reason is null or char_length(change_reason) <= 200),
  source        text not null default 'manual' check (source in ('manual', 'suggestion')),
  suggestion_id uuid, -- 外部キーは Phase 4 で suggestions を作るときに付ける
  created_at    timestamptz not null default now(),
  constraint routine_versions_routine_fk
    foreign key (routine_id, user_id) references public.routines (id, user_id) on delete cascade,
  constraint routine_versions_no unique (routine_id, version_no),
  constraint routine_versions_id_routine unique (id, routine_id),
  -- 同じルーティンで有効期間が重ならない
  constraint routine_versions_no_overlap
    exclude using gist (routine_id with =, daterange(valid_from, valid_to, '[)') with &&),
  constraint routine_versions_suggestion check ((source = 'suggestion') = (suggestion_id is not null))
);
create index routine_versions_current on public.routine_versions (routine_id) where valid_to is null;

-- ---------------------------------------------------------------------
-- occurrences：予定1回分（F-201〜203）。作成時の版の設定を写す
--   一意：(routine_id, planned_date)。予定日は開始時刻の JST の日付（0:00 をまたいでも開始日）
-- ---------------------------------------------------------------------
create table public.occurrences (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null,
  routine_id           uuid not null,
  routine_version_id   uuid not null,
  planned_date         date not null,
  planned_start_at     timestamptz not null,
  planned_duration_min integer not null check (planned_duration_min between 5 and 480),
  status               text not null default 'scheduled'
                       check (status in ('scheduled', 'notified', 'postponed', 'done', 'skipped', 'missed', 'cancelled')),
  next_remind_at       timestamptz,
  postpone_count       integer not null default 0 check (postpone_count >= 0),
  closed_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint occurrences_routine_fk
    foreign key (routine_id, user_id) references public.routines (id, user_id) on delete cascade,
  constraint occurrences_version_fk
    foreign key (routine_version_id, routine_id) references public.routine_versions (id, routine_id),
  constraint occurrences_once_per_day unique (routine_id, planned_date),
  constraint occurrences_id_user unique (id, user_id),
  constraint occurrences_start_on_planned_date
    check ((planned_start_at at time zone 'Asia/Tokyo')::date = planned_date),
  -- 確定した状態（完了・見送り・未実施・取り消し）だけが closed_at を持つ
  constraint occurrences_closed
    check ((status in ('done', 'skipped', 'missed', 'cancelled')) = (closed_at is not null)),
  constraint occurrences_postponed_has_remind check (status <> 'postponed' or next_remind_at is not null)
);
create index occurrences_by_user_date on public.occurrences (user_id, planned_date);
create index occurrences_open on public.occurrences (planned_date)
  where status in ('scheduled', 'notified', 'postponed');
create index occurrences_by_version on public.occurrences (routine_version_id);

-- ---------------------------------------------------------------------
-- executions：実績（F-402, F-405）。修正は新しい行を作り、古い行に superseded_by を付ける
--   予定日の写しを持ち、「予定日の翌日以降に実施」を生成列で判定する
--   start_source：開始時刻の決め方（planned＝予定時刻、now＝今終わった、timer、manual＝指定）
-- ---------------------------------------------------------------------
create table public.executions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  occurrence_id       uuid not null,
  planned_date        date not null,
  actual_start_at     timestamptz not null,
  actual_end_at       timestamptz not null,
  actual_duration_min integer not null check (actual_duration_min between 1 and 1440),
  executed_date       date not null,
  is_late_day         boolean generated always as (executed_date > planned_date) stored,
  start_source        text not null check (start_source in ('planned', 'now', 'timer', 'manual')),
  recorded_at         timestamptz not null default now(),
  superseded_by       uuid references public.executions (id),
  constraint executions_occurrence_fk
    foreign key (occurrence_id, user_id) references public.occurrences (id, user_id) on delete cascade,
  constraint executions_end check (actual_end_at = actual_start_at + make_interval(mins => actual_duration_min)),
  constraint executions_executed_date check (executed_date = (actual_start_at at time zone 'Asia/Tokyo')::date),
  constraint executions_not_self check (superseded_by is null or superseded_by <> id)
);
-- 今の実績は予定ごとに1件だけ
create unique index executions_current on public.executions (occurrence_id) where superseded_by is null;
create index executions_by_user on public.executions (user_id, executed_date);

-- ---------------------------------------------------------------------
-- occurrence_events：状態の変化をすべて記録する（追記だけ。延期の履歴・理由を含む）
--   reason_code は F-408 の選択肢。延期の選択肢（postpone_option）も分析用に残す
-- ---------------------------------------------------------------------
create table public.occurrence_events (
  id              bigint generated always as identity primary key,
  user_id         uuid not null,
  occurrence_id   uuid not null,
  type            text not null
                  check (type in ('done', 'postponed', 'skipped', 'missed', 'edited', 'cancelled', 'notified')),
  from_status     text,
  to_status       text,
  remind_at       timestamptz,
  postpone_option text check (postpone_option in ('10m', '30m', '1h', 'today_at', 'tomorrow_same')),
  reason_code     text check (reason_code in ('no_time', 'tired', 'forgot', 'plans', 'sick', 'unmotivated', 'other')),
  reason_text     text check (reason_text is null or char_length(reason_text) <= 500),
  execution_id    uuid references public.executions (id),
  actor           text not null default 'user' check (actor in ('user', 'system')),
  detail          jsonb,
  created_at      timestamptz not null default now(),
  constraint occurrence_events_occurrence_fk
    foreign key (occurrence_id, user_id) references public.occurrences (id, user_id) on delete cascade,
  constraint occurrence_events_postponed
    check (type <> 'postponed' or (remind_at is not null and postpone_option is not null)),
  constraint occurrence_events_reason_text check (reason_text is null or reason_code is not null),
  constraint occurrence_events_done check (type <> 'done' or execution_id is not null)
);
create index occurrence_events_by_occurrence on public.occurrence_events (occurrence_id, created_at);
create index occurrence_events_by_user on public.occurrence_events (user_id, created_at);
create index occurrence_events_execution on public.occurrence_events (execution_id) where execution_id is not null;

-- ---------------------------------------------------------------------
-- 履歴を書き換えさせない（画面には書き込み権限そのものが無いが、DB の中でも守る）
--   外部キーの連鎖削除（アカウント削除 F-004）だけは通す：連鎖はトリガーの中で動くので深さが 2 以上
-- ---------------------------------------------------------------------
create function public.guard_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception '% は削除できません（履歴を残すため）', tg_table_name using errcode = '42501';
  end if;

  -- 列名は表ごとに違うので、jsonb にしてから比べる（PL/pgSQL は AND を途中で打ち切らないため、
  -- 存在しない列 old.valid_to などを直接書くと、別の表で実行したときにエラーになる）
  -- 例外1：版の有効期間を閉じる（valid_to を null から日付へ。ほかの列は同じ）
  if tg_table_name = 'routine_versions' then
    if to_jsonb(old) -> 'valid_to' = 'null'::jsonb and to_jsonb(new) -> 'valid_to' <> 'null'::jsonb
       and (to_jsonb(new) - 'valid_to') = (to_jsonb(old) - 'valid_to') then
      return new;
    end if;
  end if;

  -- 例外2：実績に「修正後の行」を一度だけ付ける（F-407、Should）
  if tg_table_name = 'executions' then
    if to_jsonb(old) -> 'superseded_by' = 'null'::jsonb and to_jsonb(new) -> 'superseded_by' <> 'null'::jsonb
       and (to_jsonb(new) - 'superseded_by') = (to_jsonb(old) - 'superseded_by') then
      return new;
    end if;
  end if;

  raise exception '% は変更できません（履歴を残すため）', tg_table_name using errcode = '42501';
end;
$$;

create trigger routine_versions_guard before update or delete on public.routine_versions
  for each row execute function public.guard_history();
create trigger executions_guard before update or delete on public.executions
  for each row execute function public.guard_history();
create trigger occurrence_events_guard before update or delete on public.occurrence_events
  for each row execute function public.guard_history();

-- 予定は状態が変わる表なので UPDATE は RPC に任せるが、削除はさせない（P-03）
create function public.guard_occurrence_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'occurrences は削除できません（取り消しは status = cancelled）' using errcode = '42501';
end;
$$;
create trigger occurrences_no_delete before delete on public.occurrences
  for each row execute function public.guard_occurrence_delete();

-- ---------------------------------------------------------------------
-- Phase 0 の表とのつなぎ
-- ---------------------------------------------------------------------
-- 通知ジョブを予定に結ぶ（kind = 'test' は occurrence_id が null のまま）
alter table public.notification_jobs
  add constraint notification_jobs_occurrence_fk
  foreign key (occurrence_id, user_id) references public.occurrences (id, user_id) on delete cascade;

-- Phase 0 の Advisor 指摘：外部キーの索引がない
create index notification_deliveries_job on public.notification_deliveries (job_id);
create index notification_deliveries_subscription on public.notification_deliveries (subscription_id);

-- ---------------------------------------------------------------------
-- 分析用のビュー（Phase 3・4 の土台）。RLS は呼び出した人の権限で効く（security_invoker）
--   1行＝予定1回分。予定・実績・遅延・所要時間・時間帯・最後の理由を並べる
-- ---------------------------------------------------------------------
create view public.occurrence_facts
with (security_invoker = true)
as
select
  o.id                                         as occurrence_id,
  o.user_id,
  o.routine_id,
  o.routine_version_id,
  v.version_no,
  o.planned_date,
  extract(isodow from o.planned_date)::integer as planned_weekday,
  o.planned_start_at,
  (o.planned_start_at at time zone 'Asia/Tokyo')::time as planned_start_time_jst,
  case
    when extract(hour from o.planned_start_at at time zone 'Asia/Tokyo') between 4 and 6 then 'early'
    when extract(hour from o.planned_start_at at time zone 'Asia/Tokyo') between 7 and 9 then 'morning'
    when extract(hour from o.planned_start_at at time zone 'Asia/Tokyo') between 10 and 13 then 'midday'
    when extract(hour from o.planned_start_at at time zone 'Asia/Tokyo') between 14 and 17 then 'afternoon'
    when extract(hour from o.planned_start_at at time zone 'Asia/Tokyo') between 18 and 21 then 'evening'
    else 'night'
  end                                          as time_band,
  o.planned_duration_min,
  o.status,
  -- 達成率の分母に入るか（F-502：完了・見送り・未実施。延期中・予定中・取り消しは入らない）
  o.status in ('done', 'skipped', 'missed')    as is_final,
  o.postpone_count,
  e.id                                         as execution_id,
  e.actual_start_at,
  e.actual_end_at,
  e.actual_duration_min,
  e.executed_date,
  e.is_late_day,
  e.start_source,
  round(extract(epoch from (e.actual_start_at - o.planned_start_at)) / 60.0)::integer as delay_min,
  round(e.actual_duration_min::numeric / o.planned_duration_min, 3) as duration_ratio,
  ev.reason_code                               as closing_reason_code
from public.occurrences o
join public.routine_versions v on v.id = o.routine_version_id
left join public.executions e on e.occurrence_id = o.id and e.superseded_by is null
left join lateral (
  select x.reason_code
    from public.occurrence_events x
   where x.occurrence_id = o.id and x.type in ('skipped', 'missed') and x.reason_code is not null
   order by x.created_at desc, x.id desc
   limit 1
) ev on true;
