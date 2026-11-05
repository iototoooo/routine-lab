// 定期送信（pg_cron → pg_net から毎分、送るジョブがあるときだけ呼ばれる）。
// 守り：CRON_SECRET ヘッダーの一致が必須。宛先・文面はリクエストから受け取らず、DB のジョブから決める。
// docs/plan.md 4章・4.1 節

import { timingSafeEqual } from "../_shared/security.ts";
import { deliverToUser, summarize } from "../_shared/deliver.ts";
import { testPayload, type NotificationPayload } from "../_shared/payload.ts";
import {
  adminClient,
  fetchSender,
  json,
  requireEnv,
  supabaseStore,
  vapidFromEnv,
} from "../_shared/supabase-store.ts";

const MAX_JOBS_PER_RUN = 50;

type Job = {
  id: string;
  user_id: string;
  occurrence_id: string | null;
  kind: "test" | "initial" | "snooze";
  fire_at: string;
};

function payloadForJob(job: Job): NotificationPayload | null {
  if (job.kind === "test") return testPayload(job.id, new Date());
  // initial / snooze の文面（ルーティン名・予定時刻・所要時間）は Phase 2 で予定の表から組み立てる
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { message: "method not allowed" });

  let secret: string;
  try {
    secret = requireEnv("CRON_SECRET");
  } catch {
    // 秘密が未設定のまま動かさない
    return json(500, { message: "not configured" });
  }
  if (!timingSafeEqual(req.headers.get("x-cron-secret") ?? "", secret)) {
    return json(401, { message: "unauthorized" });
  }

  try {
    return await run();
  } catch (e) {
    // claim 後に落ちたジョブは claim_due_jobs が5分後に回収する
    console.error("send-push unexpected error", e instanceof Error ? e.name : typeof e);
    return json(500, { message: "failed" });
  }
});

async function run(): Promise<Response> {
  const started = performance.now();
  const db = adminClient();
  const store = supabaseStore(db);
  const vapid = vapidFromEnv();

  const { data: jobs, error } = await db.rpc("claim_due_jobs", { p_limit: MAX_JOBS_PER_RUN });
  if (error) {
    console.error("claim_due_jobs failed", error.code);
    return json(500, { message: "claim failed" });
  }

  let sent = 0;
  let failed = 0;
  for (const job of (jobs ?? []) as Job[]) {
    const payload = payloadForJob(job);
    if (!payload) {
      await db.rpc("finish_job", { p_job_id: job.id, p_ok: false, p_error: "unsupported kind" });
      failed++;
      continue;
    }
    const outcomes = await deliverToUser({
      userId: job.user_id,
      jobId: job.id,
      payload,
      vapid,
      store,
      send: fetchSender,
    });
    const s = summarize(outcomes);
    const ok = s.sent > 0;
    await db.rpc("finish_job", {
      p_job_id: job.id,
      p_ok: ok,
      p_error: ok ? null : s.devices === 0 ? "no active subscription" : "all deliveries failed",
    });
    if (ok) sent++;
    else failed++;
  }

  const ms = Math.round(performance.now() - started);
  // 計測用（Phase 0 の判定材料）。個人を特定できる値は出さない
  console.log(JSON.stringify({ fn: "send-push", jobs: jobs?.length ?? 0, sent, failed, ms }));
  return json(200, { jobs: jobs?.length ?? 0, sent, failed, ms });
}
