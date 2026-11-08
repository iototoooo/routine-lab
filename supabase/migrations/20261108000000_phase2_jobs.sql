-- =====================================================================
-- Phase 2：予定の状態に合わせて通知ジョブを作る・取り消す（docs/phase2-plan.md 2章・3章）
--
-- 予定（occurrences）が作られる・変わるたびに、トリガーがその予定の通知ジョブを合わせる。
--   予定どおり（scheduled）       → 予定時刻の initial ジョブ1つ
--   延期中（postponed）           → next_remind_at の snooze ジョブ1つ
--   通知済み（notified）          → 新しいジョブは作らない
--   完了・見送り・未実施・取り消し → 送っていないジョブ（pending）をすべて取り消す
-- 期限は通知時刻＋60分（判断事項4）。通知時刻を過ぎたジョブは新しく作らない（判断事項1）。
-- 取り消したジョブは消さずに残し、理由（cancel_reason）と時刻を記録する（Phase 3・4 の分析用）。
-- 基準の時刻は予定の updated_at（Phase 1 の関数が「今」を入れている。テストで時刻を指定できる）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 通知ジョブに、取り消しの理由と時刻を足す
--   closed      予定が確定した（完了・見送り・未実施・取り消し）
--   rescheduled 編集で予定時刻が変わった
--   postponed   延期したので予定時刻の通知は不要になった
--   superseded  延期し直したので古い再通知は不要になった
--   stale       送る直前の確認で、予定の状態・時刻と合わなかった
-- ---------------------------------------------------------------------
alter table public.notification_jobs
  add column cancel_reason text
    check (cancel_reason in ('closed', 'rescheduled', 'postponed', 'superseded', 'stale')),
  add column cancelled_at timestamptz,
  add constraint notification_jobs_cancel_reason check (cancel_reason is null or status = 'cancelled');

-- 予定ごとのジョブを引く索引（同期・送る直前の確認で使う）
create index notification_jobs_by_occurrence on public.notification_jobs (occurrence_id) where occurrence_id is not null;

-- ---------------------------------------------------------------------
-- 1つの予定の通知ジョブを、予定の状態に合わせる
-- ---------------------------------------------------------------------
create function public._sync_occurrence_jobs(p_occ public.occurrences, p_now timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_fire timestamptz;
begin
  if p_occ.status in ('done', 'skipped', 'missed', 'cancelled') then
    update public.notification_jobs
       set status = 'cancelled', cancel_reason = 'closed', cancelled_at = p_now
     where occurrence_id = p_occ.id and status = 'pending';
    return;
  end if;

  if p_occ.status = 'scheduled' then
    v_kind := 'initial';
    v_fire := p_occ.planned_start_at;
  elsif p_occ.status = 'postponed' then
    v_kind := 'snooze';
    v_fire := p_occ.next_remind_at;
  else
    return; -- notified：送信済み。新しいジョブは作らない
  end if;

  -- あるべきジョブ以外の、送っていないジョブを取り消す
  update public.notification_jobs
     set status = 'cancelled',
         cancelled_at = p_now,
         cancel_reason = case
           when kind = 'initial' and v_kind = 'snooze' then 'postponed'
           when kind = 'initial' then 'rescheduled'
           else 'superseded'
         end
   where occurrence_id = p_occ.id
     and status = 'pending'
     and not (kind = v_kind and fire_at = v_fire);

  -- 通知時刻を過ぎていれば新しく作らない
  if v_fire is null or v_fire <= p_now then
    return;
  end if;

  -- 同じ予定・種類・時刻のジョブは1つだけ（F-305）。取り消し済みなら送信待ちに戻す
  insert into public.notification_jobs (user_id, occurrence_id, kind, fire_at, expires_at, created_at)
  values (p_occ.user_id, p_occ.id, v_kind, v_fire, v_fire + interval '60 minutes', p_now)
  on conflict (occurrence_id, kind, fire_at) do update
     set status = 'pending', attempts = 0, locked_at = null, last_error = null,
         sent_at = null, cancel_reason = null, cancelled_at = null
   where notification_jobs.status = 'cancelled';
end;
$$;

-- ---------------------------------------------------------------------
-- トリガー：予定の作成と、状態・予定時刻・再通知時刻の変更で同期する
-- ---------------------------------------------------------------------
create function public.occurrences_sync_jobs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.status = old.status
     and new.planned_start_at = old.planned_start_at
     and new.next_remind_at is not distinct from old.next_remind_at then
    return null;
  end if;
  perform public._sync_occurrence_jobs(new, new.updated_at);
  return null;
end;
$$;

create trigger occurrences_sync_jobs
  after insert or update on public.occurrences
  for each row execute function public.occurrences_sync_jobs();

revoke all on function public._sync_occurrence_jobs(public.occurrences, timestamptz) from public, anon, authenticated;
revoke all on function public.occurrences_sync_jobs() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 反映した時点の未来の予定にもジョブを作る（判断事項1：通知時刻を過ぎた予定には作らない）
-- ---------------------------------------------------------------------
select public._sync_occurrence_jobs(o, now())
  from public.occurrences o
 where o.status in ('scheduled', 'postponed');
