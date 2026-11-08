-- =====================================================================
-- Phase 3：分析の土台（docs/phase3-plan.md 2章）
--
-- 1. テスト用ルーティンの印（routines.exclude_from_analytics）と、それを切り替える RPC
--    - 分析の集計から外すかどうかだけを表す。予定・実績・版・イベント・通知ジョブには一切触れない
--    - 版（routine_versions）には入れない（設定の履歴ではなく、分析の対象かどうかの印のため）
-- 2. 延期・見送り・未実施のイベントを、予定日・ルーティン・版で引けるビュー occurrence_reason_facts
--    - イベントの表には予定日がないため、分析の期間で絞れるようにする
--    - security_invoker なので、元の表の RLS（本人の行だけ）がそのまま効く
-- 既存の表の行・関数・トリガー・cron・通知の仕組みは変えない。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. テスト用ルーティンの印
-- ---------------------------------------------------------------------
alter table public.routines
  add column exclude_from_analytics boolean not null default false;

create function public._set_routine_analytics(p_user uuid, p_now timestamptz, p_routine_id uuid, p_exclude boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_exclude is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  -- アーカイブ済みでも変えられる（過去の記録を分析から外す・戻すため）
  update public.routines
     set exclude_from_analytics = p_exclude, updated_at = p_now
   where id = p_routine_id and user_id = p_user;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return p_exclude;
end;
$$;

create function public.set_routine_analytics(p_routine_id uuid, p_exclude boolean)
returns boolean
language sql
security definer
set search_path = ''
as $$ select public._set_routine_analytics((select auth.uid()), now(), p_routine_id, p_exclude) $$;

revoke all on function
  public._set_routine_analytics(uuid, timestamptz, uuid, boolean),
  public.set_routine_analytics(uuid, boolean)
from public, anon, authenticated;
grant execute on function public.set_routine_analytics(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 2. 延期・見送り・未実施のイベント（1行＝イベント1件）
-- ---------------------------------------------------------------------
create view public.occurrence_reason_facts
with (security_invoker = true)
as
select
  e.id               as event_id,
  e.occurrence_id,
  e.user_id,
  o.routine_id,
  o.routine_version_id,
  o.planned_date,
  e.type,
  e.reason_code,
  e.postpone_option,
  e.remind_at,
  e.actor,
  e.created_at
from public.occurrence_events e
join public.occurrences o on o.id = e.occurrence_id
where e.type in ('postponed', 'skipped', 'missed');

revoke all on public.occurrence_reason_facts from anon, authenticated;
grant select on public.occurrence_reason_facts to authenticated;
