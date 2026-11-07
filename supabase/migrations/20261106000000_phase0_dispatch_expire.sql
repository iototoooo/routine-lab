-- =====================================================================
-- Phase 0：dispatch_due_push の修正（20261105000100_phase0_cron.sql は適用済みのため新しいファイルで直す）
--
-- 直す点：期限切れ（expires_at を過ぎた）の pending ジョブがあると、
--   「送るジョブがある」と判断して毎分 send-push を呼んでしまう。
--   send-push 側の claim_due_jobs が expired にするので通常は1回で止まるが、
--   合言葉の不一致などで send-push が失敗し続けると、期限切れのジョブのために毎分呼び続ける。
-- 対策：呼ぶ前に、期限切れの pending をこの関数の中で expired にする（Edge Function を呼ばずに片付ける）。
--   これで send-push を呼ぶのは「期限内で送る時刻になったジョブ」か「止まった送信の回収」があるときだけになり、
--   失敗が続いても呼び出しはジョブの期限（最大60分）までで止まる。
-- =====================================================================

create or replace function public.dispatch_due_push()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  update public.notification_jobs
     set status = 'expired'
   where status = 'pending' and expires_at <= now();

  if not exists (
    select 1 from public.notification_jobs
     where (status = 'pending' and fire_at <= now())
        or (status = 'sending' and locked_at < now() - interval '5 minutes')
  ) then
    return;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'send_push_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    raise log 'dispatch_due_push: vault secrets are not set';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
end;
$$;

-- create or replace は権限を引き継ぐが、念のため明示する（service_role 専用。pg_cron は postgres で動く）
revoke execute on function public.dispatch_due_push() from public, anon, authenticated;
