-- =====================================================================
-- Phase 1：権限と RLS（P-06、docs/phase1-plan.md 2.1 節）
--   - 画面（authenticated）は本人の行の SELECT だけ。INSERT / UPDATE / DELETE は一切許可しない
--     （書き込みは 20261107000200 の RPC だけ。版の不変・実績の追記だけ・イベントの記録を DB で保証する）
--   - anon には何も許可しない
--   - Supabase の既定（public の新しい表・関数を anon / authenticated に自動で公開する）に頼らず、
--     ここで明示的に revoke / grant する
-- =====================================================================

alter table public.routines          enable row level security;
alter table public.routine_versions  enable row level security;
alter table public.occurrences       enable row level security;
alter table public.executions        enable row level security;
alter table public.occurrence_events enable row level security;

revoke all on public.routines, public.routine_versions, public.occurrences,
              public.executions, public.occurrence_events, public.occurrence_facts
  from anon, authenticated;
revoke all on sequence public.occurrence_events_id_seq from anon, authenticated;

grant select on public.routines, public.routine_versions, public.occurrences,
                public.executions, public.occurrence_events
  to authenticated;
-- ビューは security_invoker なので、上の表の RLS がそのまま効く
grant select on public.occurrence_facts to authenticated;

create policy routines_select_own on public.routines
  for select to authenticated using (user_id = (select auth.uid()));
create policy routine_versions_select_own on public.routine_versions
  for select to authenticated using (user_id = (select auth.uid()));
create policy occurrences_select_own on public.occurrences
  for select to authenticated using (user_id = (select auth.uid()));
create policy executions_select_own on public.executions
  for select to authenticated using (user_id = (select auth.uid()));
create policy occurrence_events_select_own on public.occurrence_events
  for select to authenticated using (user_id = (select auth.uid()));

-- 曜日チェックの関数は制約の中で使うだけ。外からは呼ばせない
revoke all on function public.is_valid_weekdays(smallint[]) from public, anon, authenticated;
revoke all on function public.guard_history() from public, anon, authenticated;
revoke all on function public.guard_occurrence_delete() from public, anon, authenticated;
