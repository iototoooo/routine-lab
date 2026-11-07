-- =====================================================================
-- Phase 1：予定の作成と未実施の確定を毎日動かす（F-201, F-406、docs/phase1-plan.md 2章）
--   cron の時刻は UTC。0:00 JST = 15:00 UTC（前日）
--   - 0:00 JST：今日と明日の予定を作る（その前に、期限を過ぎた予定を未実施にする）
--   - 0:05 JST：未実施の確定だけをもう一度（0:00 の処理が失敗した場合の保険）
--   どちらも外部への通信はしない（DB の中だけで完結する）。通知ジョブは作らない（判断事項4）
--   アプリを開いたときにも ensure_occurrences() が同じ処理を行うので、cron が止まっていても正しくなる
-- =====================================================================

select cron.schedule('routine-lab-ensure-occurrences', '0 15 * * *', $$select public.ensure_occurrences_all()$$);
select cron.schedule('routine-lab-close-missed', '5 15 * * *', $$select public.close_missed()$$);
