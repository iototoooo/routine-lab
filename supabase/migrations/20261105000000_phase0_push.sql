-- =====================================================================
-- Phase 0：通知の試作に必要な最小の表・RLS・関数（docs/plan.md 8章 Phase 0、4.1 節）
--  - 全表で RLS を有効にし、画面（authenticated）からは本人の行だけ
--  - 送信系の関数は service_role（Edge Function）専用。anon / authenticated からは実行不可
--  - 適用済みのマイグレーションは書き換えない。修正は新しいファイルで行う
-- =====================================================================

-- ---------------------------------------------------------------------
-- profiles：利用者ごとの設定（登録時に自動作成）
-- ---------------------------------------------------------------------
create table public.profiles (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  timezone           text not null default 'Asia/Tokyo',
  default_snooze_min integer not null default 10 check (default_snooze_min between 5 and 240),
  quiet_hours        jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- push_subscriptions：通知を送る端末（F-302, F-306）
-- ---------------------------------------------------------------------
create table public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  endpoint        text not null unique
                  check (endpoint like 'https://%' and length(endpoint) <= 1000),
  p256dh          text not null check (length(p256dh) between 80 and 100),
  auth            text not null check (length(auth) between 16 and 32),
  user_agent      text check (length(user_agent) <= 300),
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  disabled_at     timestamptz
);

create index push_subscriptions_active_by_user
  on public.push_subscriptions (user_id) where disabled_at is null;

-- ---------------------------------------------------------------------
-- notification_jobs：送る予定の通知（F-305, F-307）
--   kind = 'test' は Phase 0 の試作用（予定に紐づかない）。
--   occurrence_id の外部キーは Phase 1 で occurrences を作るときに追加する。
-- ---------------------------------------------------------------------
create table public.notification_jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  occurrence_id uuid,
  kind          text not null check (kind in ('initial', 'snooze', 'test')),
  fire_at       timestamptz not null,
  expires_at    timestamptz not null,
  status        text not null default 'pending'
                check (status in ('pending', 'sending', 'sent', 'failed', 'expired', 'cancelled')),
  attempts      integer not null default 0,
  locked_at     timestamptz,
  sent_at       timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  constraint notification_jobs_once unique (occurrence_id, kind, fire_at),
  constraint notification_jobs_occurrence_required check (kind = 'test' or occurrence_id is not null),
  constraint notification_jobs_expiry_after_fire check (expires_at > fire_at)
);

create index notification_jobs_due
  on public.notification_jobs (fire_at) where status = 'pending';
create index notification_jobs_by_user
  on public.notification_jobs (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- notification_deliveries：ジョブ×端末ごとの送信結果（F-306）
-- ---------------------------------------------------------------------
create table public.notification_deliveries (
  id              bigint generated always as identity primary key,
  job_id          uuid references public.notification_jobs (id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  ok              boolean not null,
  http_status     integer,
  error           text,
  created_at      timestamptz not null default now()
);

create index notification_deliveries_by_user
  on public.notification_deliveries (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- push_test_log：テスト送信の回数制限用（画面からは読み書き不可）
-- ---------------------------------------------------------------------
create table public.push_test_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index push_test_log_by_user on public.push_test_log (user_id, created_at desc);

-- =====================================================================
-- 権限と RLS（P-06）
--   既定の自動公開に頼らず、明示的に REVOKE / GRANT する
-- =====================================================================
alter table public.profiles                enable row level security;
alter table public.push_subscriptions      enable row level security;
alter table public.notification_jobs       enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.push_test_log           enable row level security;

revoke all on public.profiles, public.push_subscriptions, public.notification_jobs,
              public.notification_deliveries, public.push_test_log
  from anon, authenticated;

-- profiles：本人の行の参照と、一部の列の更新だけ
grant select on public.profiles to authenticated;
grant update (timezone, default_snooze_min, quiet_hours, updated_at) on public.profiles to authenticated;
create policy profiles_select_own on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- push_subscriptions：本人の端末だけ参照・登録・更新できる（削除はしない。無効化で残す）
grant select on public.push_subscriptions to authenticated;
grant insert (user_id, endpoint, p256dh, auth, user_agent, disabled_at)
  on public.push_subscriptions to authenticated;
grant update (user_id, endpoint, p256dh, auth, user_agent, disabled_at)
  on public.push_subscriptions to authenticated;
create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy push_subscriptions_insert_own on public.push_subscriptions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy push_subscriptions_update_own on public.push_subscriptions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- notification_jobs / notification_deliveries：本人の行の参照だけ（作成・更新は関数経由）
grant select on public.notification_jobs, public.notification_deliveries to authenticated;
create policy notification_jobs_select_own on public.notification_jobs
  for select to authenticated using (user_id = (select auth.uid()));
create policy notification_deliveries_select_own on public.notification_deliveries
  for select to authenticated using (user_id = (select auth.uid()));

-- push_test_log：authenticated には何も許可しない（ポリシーなし＝全拒否）

-- =====================================================================
-- service_role（Edge Function）専用の関数
-- =====================================================================

-- テスト送信の回数制限：1ユーザー 1分に1回・24時間に10回（docs/plan.md 4.1 節）
create function public.consume_test_push_quota(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    return 'invalid';
  end if;
  -- 同じユーザーの同時リクエストを直列にして、すり抜けを防ぐ
  perform pg_advisory_xact_lock(hashtextextended('test_push:' || p_user_id::text, 0));

  if exists (
    select 1 from public.push_test_log
    where user_id = p_user_id and created_at > now() - interval '1 minute'
  ) then
    return 'rate_minute';
  end if;

  if (
    select count(*) from public.push_test_log
    where user_id = p_user_id and created_at > now() - interval '24 hours'
  ) >= 10 then
    return 'rate_day';
  end if;

  insert into public.push_test_log (user_id) values (p_user_id);
  return 'ok';
end;
$$;

-- 遅延テスト送信のジョブを作る（アプリを閉じた状態での受信確認用）
create function public.schedule_test_push(p_user_id uuid, p_delay_seconds integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fire timestamptz;
  v_id uuid;
begin
  if p_delay_seconds not in (60, 120, 300) then
    raise exception 'invalid delay';
  end if;
  v_fire := date_trunc('second', now()) + make_interval(secs => p_delay_seconds);
  insert into public.notification_jobs (user_id, kind, fire_at, expires_at)
  values (p_user_id, 'test', v_fire, v_fire + interval '60 minutes')
  returning id into v_id;
  return v_id;
end;
$$;

-- 送る時刻になったジョブを取り出す（二重送信の防止：FOR UPDATE SKIP LOCKED で sending にしてから送る）
create function public.claim_due_jobs(p_limit integer default 50)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 送信途中で止まったジョブ（5分以上 sending）を戻す。3回失敗したら failed
  update public.notification_jobs
     set status = case when attempts >= 3 then 'failed' else 'pending' end,
         locked_at = null,
         last_error = coalesce(last_error, 'stale sending')
   where status = 'sending' and locked_at < now() - interval '5 minutes';

  -- 期限切れ（予定時刻から60分など）は送らない（F-307）
  update public.notification_jobs
     set status = 'expired'
   where status = 'pending' and expires_at <= now();

  return query
  with due as (
    select id from public.notification_jobs
     where status = 'pending' and fire_at <= now() and expires_at > now()
     order by fire_at
     limit greatest(1, least(coalesce(p_limit, 50), 100))
     for update skip locked
  )
  update public.notification_jobs j
     set status = 'sending', locked_at = now(), attempts = j.attempts + 1
    from due
   where j.id = due.id
  returning j.*;
end;
$$;

-- ジョブの結果を記録する
create function public.finish_job(p_job_id uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.notification_jobs
     set status = case when p_ok then 'sent' else 'failed' end,
         sent_at = case when p_ok then now() else null end,
         last_error = left(p_error, 200),
         locked_at = null
   where id = p_job_id and status = 'sending';
end;
$$;

-- 端末ごとの送信結果を記録し、404 / 410 の端末を無効にする（F-306）
create function public.record_push_outcome(
  p_job_id uuid,
  p_subscription_id uuid,
  p_ok boolean,
  p_status integer,
  p_disabled boolean,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.push_subscriptions where id = p_subscription_id;
  if v_user is null then
    return;
  end if;

  insert into public.notification_deliveries (job_id, subscription_id, user_id, ok, http_status, error)
  values (p_job_id, p_subscription_id, v_user, p_ok, p_status, left(p_error, 200));

  update public.push_subscriptions
     set last_success_at = case when p_ok then now() else last_success_at end,
         disabled_at = case when p_disabled then coalesce(disabled_at, now()) else disabled_at end
   where id = p_subscription_id;
end;
$$;

-- 関数の実行権限：既定の PUBLIC 実行権を外し、service_role だけに与える
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.consume_test_push_quota(uuid) from public, anon, authenticated;
revoke execute on function public.schedule_test_push(uuid, integer) from public, anon, authenticated;
revoke execute on function public.claim_due_jobs(integer) from public, anon, authenticated;
revoke execute on function public.finish_job(uuid, boolean, text) from public, anon, authenticated;
revoke execute on function public.record_push_outcome(uuid, uuid, boolean, integer, boolean, text)
  from public, anon, authenticated;

grant execute on function public.consume_test_push_quota(uuid) to service_role;
grant execute on function public.schedule_test_push(uuid, integer) to service_role;
grant execute on function public.claim_due_jobs(integer) to service_role;
grant execute on function public.finish_job(uuid, boolean, text) to service_role;
grant execute on function public.record_push_outcome(uuid, uuid, boolean, integer, boolean, text)
  to service_role;

-- service_role が Edge Function から表を読むための権限（service_role は RLS を通らない）
grant select, insert, update on public.push_subscriptions, public.notification_jobs,
  public.notification_deliveries, public.push_test_log, public.profiles to service_role;
