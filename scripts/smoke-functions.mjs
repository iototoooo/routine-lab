#!/usr/bin/env node
// Edge Function の「守り」の確認（docs/plan.md 4.1 節、Phase 0 の安全性チェック）。
// 送ってはいけないリクエストが拒否されることだけを確認する。通知は1件も送らない。
//
// 使い方：
//   node scripts/smoke-functions.mjs <関数のベースURL> [許可するオリジン]
//   例（デプロイ後）：node scripts/smoke-functions.mjs https://<ref>.supabase.co/functions/v1 http://localhost:3000
//   例（ローカル）  ：node scripts/smoke-functions.mjs http://127.0.0.1:8000 http://localhost:3000 --local test-push
//
// 必要な値は公開値だけ（.env.local の NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY）。
// 秘密の値（CRON_SECRET・service_role キー・VAPID 秘密鍵）は使わないし、表示もしない。

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const base = args[0]?.replace(/\/+$/, "");
const allowedOrigin = args[1] ?? "http://localhost:3000";
const localIdx = args.indexOf("--local");
// --local <name>：ローカルで1つの関数だけを動かしているとき（URL にパスを付けない）
const localOnly = localIdx >= 0 ? args[localIdx + 1] : null;
if (!base) {
  console.error("使い方: node scripts/smoke-functions.mjs <関数のベースURL> [許可するオリジン] [--local <関数名>]");
  process.exit(2);
}

function readEnvLocal() {
  try {
    const out = {};
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}
const env = { ...readEnvLocal(), ...process.env };
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");

const url = (name) => (localOnly ? base : `${base}/${name}`);
const results = [];
async function check(name, fn, expectText, ok) {
  if (localOnly && !name.startsWith(localOnly)) return;
  let res;
  try {
    res = await fn();
  } catch (e) {
    results.push({ name, pass: false, detail: `通信エラー: ${e instanceof Error ? e.message : e}` });
    return;
  }
  const pass = ok(res);
  results.push({ name, pass, detail: `HTTP ${res.status}${res.code ? ` ${res.code}` : ""}（期待：${expectText}）` });
}
const rejected = (r) => r.status === 401 || r.status === 403;

// --- test-push（利用者向け。verify_jwt = true ＋ 関数内で getUser） ---
await check(
  "test-push: CORS 事前確認（許可したオリジン）",
  () => fetch(url("test-push"), {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, x-client-info, apikey, content-type",
    },
  }),
  "2xx かつ Access-Control-Allow-Origin がそのオリジン",
  (r) => r.ok && r.headers.get("access-control-allow-origin") === allowedOrigin,
);
await check(
  "test-push: CORS 事前確認（許可していないオリジン）",
  () => fetch(url("test-push"), {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
  }),
  "Access-Control-Allow-Origin が付かない",
  (r) => {
    const v = r.headers.get("access-control-allow-origin");
    return v !== "https://evil.example" && v !== "*";
  },
);
await check(
  "test-push: 認証なし",
  () => fetch(url("test-push"), { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"mode":"now"}' }),
  "401",
  rejected,
);
await check(
  "test-push: 不正なトークン",
  () => fetch(url("test-push"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalid-signature",
      ...(anonKey ? { apikey: anonKey } : {}),
    },
    body: '{"mode":"now"}',
  }),
  "401",
  rejected,
);
if (anonKey) {
  await check(
    "test-push: 公開キー（anon / publishable）だけ（ログインしていない）",
    () => fetch(url("test-push"), {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: '{"mode":"now"}',
    }),
    "401",
    rejected,
  );
}

// --- send-push（pg_cron 専用。verify_jwt = false ＋ x-cron-secret） ---
await check(
  "send-push: 合言葉なし",
  () => fetch(url("send-push"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
  "401（未設定なら 500 not configured）",
  (r) => r.status === 401 || r.status === 500,
);
await check(
  "send-push: 誤った合言葉",
  () => fetch(url("send-push"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-secret": "wrong-secret-for-smoke-test" },
    body: "{}",
  }),
  "401（未設定なら 500 not configured）",
  (r) => r.status === 401 || r.status === 500,
);
await check(
  "send-push: GET",
  () => fetch(url("send-push")),
  "405",
  (r) => r.status === 405,
);

// --- 送信用の DB 関数を一般ユーザーが呼べないこと（PostgREST 経由） ---
if (!localOnly && supabaseUrl && anonKey) {
  // 引数の形を本物に合わせる（形が違うと「関数が見つからない」404 になり、権限の確認にならない）。
  // ID は実在しないダミーなので、万一実行できてもデータは変わらない
  const zero = "00000000-0000-0000-0000-000000000000";
  const rpcArgs = {
    claim_due_jobs: { p_limit: 1 },
    consume_test_push_quota: { p_user_id: zero },
    schedule_test_push: { p_user_id: zero, p_delay_seconds: 60 },
    finish_job: { p_job_id: zero, p_ok: false, p_error: "smoke" },
    record_push_outcome: { p_job_id: zero, p_subscription_id: zero, p_ok: false, p_status: 0, p_disabled: false, p_error: "smoke" },
    dispatch_due_push: {},
    // handle_new_user はトリガー専用（戻り値 trigger）で API に公開されないため対象外
  };
  for (const [fn, body] of Object.entries(rpcArgs)) {
    await check(
      `rpc ${fn}: 公開キーでの呼び出し`,
      async () => {
        const r = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        return { status: r.status, ok: r.ok, code: j.code, headers: r.headers };
      },
      "401 / 403（permission denied, 42501）",
      (r) => (r.status === 401 || r.status === 403) && r.code === "42501",
    );
  }
}

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "OK  " : "NG  "} ${r.name} — ${r.detail}`);
}
console.log(failed ? `\n${failed} 件が期待どおりではありません` : `\nすべて期待どおり（${results.length} 件）`);
process.exit(failed ? 1 : 0);
