// 定期送信（pg_cron → pg_net から毎分、送るジョブがあるときだけ呼ばれる）。
// 守り：CRON_SECRET ヘッダーの一致が必須。宛先・文面はリクエストから受け取らず、DB のジョブと予定から決める。
// 送信の手順は _shared/dispatch.ts（Node の単体テストで確認している）。docs/plan.md 4章・4.1 節、docs/phase2-plan.md 4章

import { timingSafeEqual } from "../_shared/security.ts";
import { dispatchDueJobs } from "../_shared/dispatch.ts";
import {
  adminClient,
  dispatchDb,
  fetchSender,
  json,
  requireEnv,
  supabaseStore,
  vapidFromEnv,
} from "../_shared/supabase-store.ts";

const MAX_JOBS_PER_RUN = 50;

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
    const started = performance.now();
    const db = adminClient();
    const result = await dispatchDueJobs({
      db: dispatchDb(db),
      store: supabaseStore(db),
      vapid: vapidFromEnv(),
      send: fetchSender,
      limit: MAX_JOBS_PER_RUN,
    });
    const ms = Math.round(performance.now() - started);
    // 件数と時間だけを出す（端末の URL・鍵・文面・利用者を特定できる値は出さない）
    console.log(JSON.stringify({ fn: "send-push", ...result, ms }));
    return json(200, { ...result, ms });
  } catch (e) {
    // claim 後に落ちたジョブは claim_due_jobs が5分後に回収する
    console.error("send-push unexpected error", e instanceof Error ? e.message.slice(0, 80) : typeof e);
    return json(500, { message: "failed" });
  }
});
