-- =====================================================================
-- Phase 3 の取り消し（マイグレーション 20261109000000 を元に戻し、Phase 2 の状態にする）
--
-- 使うのは、Phase 3 の反映後に重大な問題が見つかり、Phase 2 の状態へ戻すと決めたときだけ。
-- 実行は承認後のみ：npx supabase db query --remote=<ref> -f supabase/rollback/20261109_phase3_down.sql --yes
--
-- - 予定・実績・版・イベント・通知ジョブには触れない（Phase 3 はそれらを変えていないため）。
-- - 失われるのは「分析に含めない」の印だけ（テスト用ルーティンの指定）。戻した後に再反映したら、画面で付け直す。
-- - 画面（Cloudflare Pages）も Phase 2 のコミットに戻すこと（分析画面が新しい列・ビュー・RPC を使うため）。
-- 全体を1つのトランザクションで行う。tests/db/rollback.test.ts で、Phase 2 だけの状態と同じになることを確かめている。
-- =====================================================================
begin;

drop view if exists public.occurrence_reason_facts;
drop function if exists public.set_routine_analytics(uuid, boolean);
drop function if exists public._set_routine_analytics(uuid, timestamptz, uuid, boolean);
alter table public.routines drop column if exists exclude_from_analytics;

delete from supabase_migrations.schema_migrations where version = '20261109000000';

commit;
