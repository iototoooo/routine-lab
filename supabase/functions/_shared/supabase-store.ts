// Edge Function（Deno）専用：service_role で DB に接続し、DeliveryStore を実装する。
// このファイルは Deno の import（npm:）を使うため、Node 側の型チェック・テストの対象外。

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import type { DeliveryOutcome, DeliveryStore, Subscription } from "./deliver.ts";
import type { DispatchDb, Job, JobPayloadRow } from "./dispatch.ts";
import type { VapidKeys } from "./webpush.ts";
import { pickServiceKey } from "./security.ts";

export function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

/**
 * 管理用（service_role 相当）のクライアント。キーは Function の環境変数からだけ読む（コードやログに出さない）。
 * 新しい secret キー（SUPABASE_SECRET_KEYS）を優先し、なければ旧 SUPABASE_SERVICE_ROLE_KEY。
 */
export function adminClient(): SupabaseClient {
  const key = pickServiceKey(Deno.env.get("SUPABASE_SECRET_KEYS"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!key) throw new Error("missing env: SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY");
  return createClient(requireEnv("SUPABASE_URL"), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function vapidFromEnv(): VapidKeys {
  return {
    publicKey: requireEnv("VAPID_PUBLIC_KEY"),
    privateKey: requireEnv("VAPID_PRIVATE_KEY"),
    subject: requireEnv("VAPID_SUBJECT"),
  };
}

export function supabaseStore(db: SupabaseClient): DeliveryStore {
  return {
    async listActiveSubscriptions(userId: string): Promise<Subscription[]> {
      const { data, error } = await db
        .from("push_subscriptions")
        .select("id, endpoint, p256dh, auth")
        .eq("user_id", userId)
        .is("disabled_at", null);
      if (error) throw new Error(`list subscriptions failed: ${error.code}`);
      return (data ?? []) as Subscription[];
    },
    async recordOutcome(jobId: string | null, o: DeliveryOutcome): Promise<void> {
      const { error } = await db.rpc("record_push_outcome", {
        p_job_id: jobId,
        p_subscription_id: o.subscriptionId,
        p_ok: o.ok,
        p_status: o.status,
        p_disabled: o.disabled,
        p_error: o.error,
      });
      if (error) console.error("record_push_outcome failed", error.code);
    },
  };
}

/** send-push が使う DB 関数（すべて service_role 専用。docs/phase2-plan.md 3章） */
export function dispatchDb(db: SupabaseClient): DispatchDb {
  return {
    async claim(limit) {
      const { data, error } = await db.rpc("claim_due_jobs", { p_limit: limit });
      if (error) throw new Error(`claim_due_jobs failed: ${error.code}`);
      return (data ?? []) as Job[];
    },
    async payloads(jobIds) {
      const { data, error } = await db.rpc("job_payloads", { p_job_ids: jobIds });
      if (error) throw new Error(`job_payloads failed: ${error.code}`);
      return (data ?? []) as JobPayloadRow[];
    },
    async finish(jobId, ok, err) {
      const { error } = await db.rpc("finish_job", { p_job_id: jobId, p_ok: ok, p_error: err });
      if (error) console.error("finish_job failed", error.code);
    },
    async retry(jobId, err) {
      const { data, error } = await db.rpc("retry_job", { p_job_id: jobId, p_error: err });
      if (error) throw new Error(`retry_job failed: ${error.code}`);
      return String(data);
    },
    async cancel(jobId) {
      const { error } = await db.rpc("cancel_job", { p_job_id: jobId });
      if (error) console.error("cancel_job failed", error.code);
    },
  };
}

export const fetchSender = async (req: {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}) => {
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body as Uint8Array<ArrayBuffer>,
  });
  return { status: res.status, text: () => res.text() };
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
