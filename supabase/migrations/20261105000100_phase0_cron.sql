-- =====================================================================
-- Phase 0：毎分の送信処理の呼び出し（docs/plan.md 1章・5章）
--   - 送るジョブがあるときだけ pg_net で Edge Function send-push を呼ぶ（呼び出し回数を抑える）
--   - 呼び出し先 URL と CRON_SECRET は Supabase Vault に保存する（このファイルには書かない）
--       vault のシークレット名：send_push_url / cron_secret
--     Vault に登録されるまでは、何も送らずに終わる
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create function public.dispatch_due_push()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
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

revoke execute on function public.dispatch_due_push() from public, anon, authenticated;

-- 毎分（cron の時刻は UTC。毎分なので時差の影響はない）
select cron.schedule('routine-lab-dispatch-push', '* * * * *', $$select public.dispatch_due_push()$$);
