-- =====================================================================
-- Phase 1 の取り消し（マイグレーション 20261107000000〜000300 を元に戻す）
--
-- 使うのは、Phase 1 の反映後に重大な問題が見つかり、Phase 0 の状態へ戻すと決めたときだけ。
-- 実行は承認後のみ：npx supabase db query --remote=<ref> -f supabase/rollback/20261107_phase1_down.sql --yes
--
-- 注意：Phase 1 の表（ルーティン・予定・実績・イベント）に記録したデータもすべて消える。
-- Phase 0 の表（profiles・push_subscriptions・push_test_log・notification_jobs・notification_deliveries）の
-- 行には触れない（外部キー1つと索引2つを外すだけ）。Secrets・Vault・毎分の通知 cron には触れない。
-- 全体を1つのトランザクションで行うので、途中で失敗すれば何も変わらない。
-- tests/db/rollback.test.ts で、反映 → 取り消しの後に Phase 0 だけの状態と同じになることを確かめている。
-- =====================================================================
begin;

select cron.unschedule(jobname) from cron.job
 where jobname in ('routine-lab-ensure-occurrences', 'routine-lab-close-missed');

alter table public.notification_jobs drop constraint if exists notification_jobs_occurrence_fk;
drop index if exists public.notification_deliveries_job;
drop index if exists public.notification_deliveries_subscription;

-- 1) 分析用ビューと、表の行の型を使う関数（_lock_open_occurrence など）を先に消す
drop view if exists public.occurrence_facts;
drop function if exists
  public.ensure_occurrences(), public.ensure_occurrences_all(), public.close_missed(),
  public.create_routine, public.edit_routine, public.archive_routine,
  public.record_done, public.postpone, public.skip_occurrence,
  public._ensure_occurrences, public._close_missed, public._create_routine, public._edit_routine,
  public._archive_routine, public._lock_open_occurrence, public._record_done, public._postpone, public._skip,
  public._normalize_weekdays;

-- 2) 表（トリガー・制約・索引も一緒に消える）
drop table if exists public.occurrence_events, public.executions, public.occurrences,
                     public.routine_versions, public.routines;

-- 3) 表の制約・トリガーが使っていた関数
drop function if exists
  public.guard_history(), public.guard_occurrence_delete(), public.is_valid_weekdays,
  public.occurrence_deadline, public.jst_instant, public.jst_date;

drop extension if exists btree_gist;

delete from supabase_migrations.schema_migrations
 where version in ('20261107000000', '20261107000100', '20261107000200', '20261107000300');

commit;
