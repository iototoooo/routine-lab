// テスト送信（設定画面のボタンから、ログイン中の本人だけが使える）。
// 守り：
//  - Authorization のアクセストークンを Auth サーバーで検証し、本人を確定する（未ログインは 401）
//  - 送信先は「確定した本人の有効な端末」だけ。本文の user_id・endpoint・文面は受け付けない
//  - 回数制限：1ユーザー 1分に1回・1日10回（DB 関数 consume_test_push_quota。超過は 429）
// docs/plan.md 4.1 節

import { bearerToken, corsHeaders, parseTestPushRequest } from "../_shared/security.ts";
import { deliverToUser, summarize } from "../_shared/deliver.ts";
import { testPayload } from "../_shared/payload.ts";
import {
  adminClient,
  fetchSender,
  json,
  supabaseStore,
  vapidFromEnv,
} from "../_shared/supabase-store.ts";

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"), Deno.env.get("ALLOWED_ORIGINS") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    return await handle(req, cors);
  } catch (e) {
    // 設定漏れなどの想定外のエラー。詳細（秘密を含みうる）は返さず、種類だけログに残す
    console.error("test-push unexpected error", e instanceof Error ? e.name : typeof e);
    return json(500, { message: "処理に失敗しました" }, cors);
  }
});

async function handle(req: Request, cors: Record<string, string>): Promise<Response> {
  if (req.method !== "POST") return json(405, { message: "method not allowed" }, cors);

  const token = bearerToken(req.headers.get("authorization"));
  if (!token) return json(401, { message: "ログインが必要です" }, cors);

  const db = adminClient();
  const { data: userData, error: authError } = await db.auth.getUser(token);
  const user = userData?.user;
  if (authError || !user) return json(401, { message: "ログインが必要です" }, cors);

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    // 不正な JSON は下の検証で弾く
  }
  const request = parseTestPushRequest(body);
  if (!request) return json(400, { message: "リクエストの形式が正しくありません" }, cors);

  const { data: quota, error: quotaError } = await db.rpc("consume_test_push_quota", {
    p_user_id: user.id,
  });
  if (quotaError) {
    console.error("consume_test_push_quota failed", quotaError.code);
    return json(500, { message: "処理に失敗しました" }, cors);
  }
  if (quota === "rate_minute") {
    return json(429, { message: "テスト通知は1分に1回までです。少し待ってください。" }, cors);
  }
  if (quota === "rate_day") {
    return json(429, { message: "テスト通知は1日10回までです。" }, cors);
  }
  if (quota !== "ok") return json(500, { message: "処理に失敗しました" }, cors);

  if (request.mode === "delayed") {
    // ジョブとして登録し、pg_cron → send-push の経路で送る（アプリを閉じた状態での受信確認用）
    const { error } = await db.rpc("schedule_test_push", {
      p_user_id: user.id,
      p_delay_seconds: request.delaySeconds,
    });
    if (error) {
      console.error("schedule_test_push failed", error.code);
      return json(500, { message: "予約に失敗しました" }, cors);
    }
    return json(
      200,
      { message: `${request.delaySeconds / 60}分後に送ります。アプリを閉じて待ってください（1〜2分遅れることがあります）。` },
      cors,
    );
  }

  const started = performance.now();
  const outcomes = await deliverToUser({
    userId: user.id,
    jobId: null,
    payload: testPayload(crypto.randomUUID(), new Date()),
    vapid: vapidFromEnv(),
    store: supabaseStore(db),
    send: fetchSender,
    ttlSeconds: 600,
  });
  const s = summarize(outcomes);
  console.log(JSON.stringify({ fn: "test-push", ...s, ms: Math.round(performance.now() - started) }));
  if (s.devices === 0) return json(200, { message: "登録済みの端末がありません。" }, cors);
  return json(
    200,
    { message: `${s.devices}台中 ${s.sent}台に送信しました${s.disabled ? `（${s.disabled}台は無効化）` : ""}。` },
    cors,
  );
}
