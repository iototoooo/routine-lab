#!/usr/bin/env node
// CRON_SECRET（Edge Function の Secrets）と Vault（send_push_url / cron_secret）を設定し、
// pg_cron → pg_net → send-push の予約通知の経路を動かす／止める（docs/plan.md 4.1 節・8章 Phase 0 手順8）。
//
// 守っていること：
//  - 合言葉は DB の中で乱数から作る（Vault の cron_secret）。SQL の文面に秘密の値が載らないので、
//    SQL がエラーになって DB のログに文面が残っても秘密は漏れない
//  - 合言葉をこのプロセスに読み込むのは Edge Function 側へ渡す1回だけ。画面・ログには出さず、
//    CLI へは一時ファイル（OS の一時フォルダ、所有者のみ読み書き）で渡して必ず削除する
//  - 一致の確認は SHA-256 の比較だけで行う（`secrets list` が返すのも SHA-256）
//  - 「送信の入口」は Vault の send_push_url。これを最後に作り、止めるときはこれだけ消す
//  - 対象は routine-lab（ref を固定）だけ。既存の値があれば --rotate なしでは止まる
//  - 何も指定しなければ読み取りだけ（dry-run）。変更は --apply / --off / --on / --rotate を付けたときだけ
//
// 使い方：
//   node scripts/setup-cron-secret.mjs            読み取りだけ：今の状態と、--apply で行う内容を表示
//   node scripts/setup-cron-secret.mjs --apply    初回の設定（期限を過ぎた未送信ジョブの取り消し → cron_secret → CRON_SECRET → send_push_url → 確認）
//   node scripts/setup-cron-secret.mjs --verify   確認だけ（送るジョブが無いときに send-push を1回呼び、通知が0件で 200 になること）
//   node scripts/setup-cron-secret.mjs --off      停止：Vault の send_push_url を消す（cron は動き続けるが何も呼ばない）
//   node scripts/setup-cron-secret.mjs --on       再開：send_push_url を作り直す（合言葉が一致しているときだけ）
//   node scripts/setup-cron-secret.mjs --rotate   合言葉の作り直し（停止 → 作り直し → 再開 → 確認）

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_REF = "vmlxzeraeimxgkjxivnl"; // routine-lab（Practice には触れない）
const SEND_PUSH_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/send-push`;

const args = process.argv.slice(2);
const mode =
  ["--apply", "--verify", "--off", "--on", "--rotate"].find((m) => args.includes(m))?.slice(2) ?? "dry-run";

let knownSecret = null; // 画面に出す文字列から必ず伏せる
const redact = (s) => {
  let t = String(s ?? "");
  if (knownSecret) t = t.split(knownSecret).join("***");
  return t.replace(/\b[0-9a-f]{64}\b/g, "***");
};
// 失敗は例外で伝える（process.exit だと finally が動かず、一時ファイルが残るため）
class SetupError extends Error {}
function fail(msg) {
  throw new SetupError(redact(msg));
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CLI（引数は固定値と一時ファイルのパスだけ。出力はすべて取り込み、伏せてから表示する） ---
function cli(cliArgs) {
  if (cliArgs.some((a) => !/^[A-Za-z0-9_.:=/\\-]+$/.test(a))) fail("想定外の引数です");
  const r = spawnSync(`npx supabase ${cliArgs.join(" ")}`, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (r.status !== 0) {
    const tail = redact(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-5).join("\n");
    fail(`supabase ${cliArgs.slice(0, 2).join(" ")} が失敗しました（終了コード ${r.status}）\n${tail}`);
  }
  return r.stdout ?? "";
}
function parseJson(out) {
  const start = out.search(/[[{]/);
  if (start < 0) return null;
  return JSON.parse(out.slice(start));
}
function withTempFile(name, content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "routine-lab-cron-"));
  const file = join(dir, name);
  try {
    writeFileSync(file, content, { mode: 0o600 });
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** SQL を実行して行を返す。write=false は読み取り専用のトランザクション */
function sql(text, { write = false } = {}) {
  return withTempFile("query.sql", text, (file) => {
    const out = cli([
      "db", "query", `--remote=${PROJECT_REF}`, "-f", file, "-o", "json",
      ...(write ? ["--yes"] : ["--read-only"]),
    ]);
    return parseJson(out)?.rows ?? [];
  });
}
function functionSecrets() {
  const j = parseJson(cli(["secrets", "list", `--remote=${PROJECT_REF}`, "-o", "json"]));
  const arr = Array.isArray(j) ? j : (Object.values(j ?? {}).find(Array.isArray) ?? []);
  return new Map(arr.map((x) => [x.name, x.value])); // value は SHA-256（秘密そのものではない）
}

// --- 状態（秘密の値は読まない。SHA-256 だけ） ---
function readState() {
  const [row] = sql(`
select
  (select count(*) from vault.secrets where name = 'cron_secret')::int as vault_cron_secret,
  (select count(*) from vault.secrets where name = 'send_push_url')::int as vault_send_push_url,
  (select count(*) from public.notification_jobs where status = 'pending' and fire_at <= now())::int as due_pending,
  (select count(*) from public.notification_jobs where status = 'pending' and fire_at > now())::int as future_pending,
  (select count(*) from public.notification_jobs where status = 'sending')::int as sending,
  (select active from cron.job where jobname = 'routine-lab-dispatch-push') as cron_active,
  (select count(*) from net.http_request_queue)::int as net_queue
`);
  // 読み取り専用のロールは Vault を復号できない（良いこと）。値があるときだけ、管理用のロールで
  // SHA-256 と URL の一致だけを読む（SELECT のみ。秘密の値そのものは返さない）
  if (row && (row.vault_cron_secret || row.vault_send_push_url)) {
    const [v] = sql(
      `select
         (select encode(extensions.digest(decrypted_secret, 'sha256'), 'hex')
            from vault.decrypted_secrets where name = 'cron_secret') as vault_cron_sha,
         (select decrypted_secret = '${SEND_PUSH_URL}'
            from vault.decrypted_secrets where name = 'send_push_url') as url_ok`,
      { write: true },
    );
    Object.assign(row, v);
  }
  const fn = functionSecrets();
  return {
    ...row,
    fn_has_cron: fn.has("CRON_SECRET"),
    match: !!row?.vault_cron_sha && fn.get("CRON_SECRET") === row.vault_cron_sha,
  };
}
function printState(s, title) {
  const yn = (b) => (b ? "あり" : "なし");
  console.log(`\n[${title}]`);
  console.log(`  Function の CRON_SECRET     : ${yn(s.fn_has_cron)}`);
  console.log(`  Vault の cron_secret        : ${yn(s.vault_cron_secret)}`);
  console.log(`  Vault の send_push_url      : ${yn(s.vault_send_push_url)}${s.vault_send_push_url ? (s.url_ok ? "（URL 正しい）" : "（URL が違う）") : ""}`);
  console.log(`  合言葉の一致（SHA-256 で比較）: ${s.fn_has_cron && s.vault_cron_secret ? (s.match ? "一致" : "不一致") : "—"}`);
  console.log(`  cron（routine-lab-dispatch-push）: ${s.cron_active === true ? "有効" : s.cron_active === false ? "停止中" : "未登録"}`);
  console.log(`  送る時刻を過ぎた未送信ジョブ: ${s.due_pending} 件 / これからのジョブ: ${s.future_pending} 件 / 送信中: ${s.sending} 件`);
  console.log(`  経路の状態                   : ${s.fn_has_cron && s.vault_cron_secret && s.vault_send_push_url && s.match ? "動作中（予約通知が送られる）" : "停止（予約通知は送られない）"}`);
}

// --- 操作 ---
function cancelOverdue() {
  const [r] = sql(
    `with u as (
       update public.notification_jobs
          set status = 'cancelled', last_error = 'cancelled before cron setup'
        where status = 'pending' and fire_at <= now()
       returning 1)
     select count(*)::int as n from u`,
    { write: true },
  );
  console.log(`- 送る時刻を過ぎた未送信ジョブを取り消しました：${r?.n ?? 0} 件（遅れて届くのを防ぐため）`);
}
function createVaultCronSecret() {
  // 値は DB の中で作る（SQL に秘密の値を書かない）
  sql(
    `select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret',
            'routine-lab: send-push の x-cron-secret') is not null as created
      where not exists (select 1 from vault.secrets where name = 'cron_secret')`,
    { write: true },
  );
  console.log("- Vault に cron_secret を作りました（値は DB の中で乱数から作成）");
}
function rotateVaultCronSecret() {
  sql(
    `select vault.update_secret(id, encode(extensions.gen_random_bytes(32), 'hex')) is null as updated
       from vault.secrets where name = 'cron_secret'`,
    { write: true },
  );
  console.log("- Vault の cron_secret を作り直しました");
}
function copySecretToFunction() {
  const [r] = sql(`select decrypted_secret as s from vault.decrypted_secrets where name = 'cron_secret'`, { write: true });
  const secret = r?.s;
  if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret)) fail("Vault の cron_secret の形式が想定外です");
  knownSecret = secret;
  withTempFile("functions.env", `CRON_SECRET=${secret}\n`, (file) => {
    cli(["secrets", "set", "--env-file", file, `--remote=${PROJECT_REF}`, "--yes"]);
  });
  const digest = sha256(secret);
  knownSecret = null;
  if (functionSecrets().get("CRON_SECRET") !== digest) fail("CRON_SECRET の登録を確認できませんでした（SHA-256 が一致しない）");
  console.log("- Edge Function の Secrets に CRON_SECRET を登録しました（一時ファイルは削除済み、SHA-256 で一致を確認）");
}
function createSendPushUrl() {
  sql(
    `select vault.create_secret('${SEND_PUSH_URL}', 'send_push_url', 'routine-lab: send-push の URL') is not null as created
      where not exists (select 1 from vault.secrets where name = 'send_push_url')`,
    { write: true },
  );
  console.log("- Vault に send_push_url を作りました（ここから予約通知が送られます）");
}
function deleteSendPushUrl() {
  const [r] = sql(
    `with d as (delete from vault.secrets where name = 'send_push_url' returning 1) select count(*)::int as n from d`,
    { write: true },
  );
  console.log(`- Vault の send_push_url を消しました：${r?.n ?? 0} 件（以後、cron は send-push を呼ばない）`);
}

async function verify() {
  console.log("\n[確認]");
  // 1) 誤った合言葉が 401 になる（= CRON_SECRET が登録されている。未登録なら 500）
  const wrong = await fetch(SEND_PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-secret": "wrong-secret-for-verify" },
    body: "{}",
  });
  console.log(`  誤った合言葉 → HTTP ${wrong.status}（期待 401）${wrong.status === 401 ? " OK" : " NG"}`);

  // 2) DB（pg_net）から Vault の値で1回呼ぶ。送るジョブが無いときだけ（通知は1件も送られない）
  const s = readState();
  if (s.due_pending > 0 || s.sending > 0) {
    console.log("  DB からの呼び出し → 送るジョブがあるため省略（通知を送らないため）");
    return wrong.status === 401;
  }
  const [r] = sql(
    `select net.http_post(
       url := (select decrypted_secret from vault.decrypted_secrets where name = 'send_push_url'),
       headers := jsonb_build_object('Content-Type', 'application/json',
                    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
       body := '{}'::jsonb,
       timeout_milliseconds := 10000) as id`,
    { write: true },
  );
  const id = Number(r?.id);
  if (!Number.isInteger(id)) fail("pg_net の呼び出しを登録できませんでした");
  let resp = null;
  for (let i = 0; i < 10 && !resp; i++) {
    await sleep(2000);
    [resp] = sql(
      `select status_code, timed_out, error_msg, left(content, 200) as content
         from net._http_response where id = ${id}`,
    );
  }
  if (!resp) {
    console.log("  DB からの呼び出し → 20秒待っても結果が記録されませんでした NG");
    return false;
  }
  let body = {};
  try { body = JSON.parse(resp.content ?? "{}"); } catch { /* 表示だけ */ }
  const ok = resp.status_code === 200 && body.jobs === 0;
  console.log(
    `  DB（pg_net）→ send-push → HTTP ${resp.status_code ?? "—"}${resp.timed_out ? "（時間切れ）" : ""}、` +
      `送ったジョブ ${body.jobs ?? "—"} 件（期待 200・0件）${ok ? " OK" : " NG"}`,
  );
  return wrong.status === 401 && ok;
}

// --- 実行 ---
async function main() {
const before = readState();
printState(before, "今の状態");

if (mode === "dry-run") {
  console.log("\n[--apply で行うこと]（今回は何も変更していません）");
  console.log(`  1. 送る時刻を過ぎた未送信ジョブ（今 ${before.due_pending} 件）を cancelled にする`);
  console.log("  2. Vault に cron_secret を作る（DB の中で乱数から作成）");
  console.log("  3. その値を Edge Function の CRON_SECRET に登録する（一時ファイル経由、SHA-256 で一致を確認）");
  console.log("  4. Vault に send_push_url を作る（ここで予約通知の経路が動き出す）");
  console.log("  5. 確認：誤った合言葉が 401、DB からの呼び出しが 200（通知は0件）");
  if (before.fn_has_cron || before.vault_cron_secret || before.vault_send_push_url) {
    console.log("\n注意：既に設定があります。--apply は止まります（作り直すなら --rotate）");
  }
  process.exit(0);
}

if (mode === "apply") {
  if (before.fn_has_cron || before.vault_cron_secret || before.vault_send_push_url) {
    fail("既に CRON_SECRET または Vault の設定があります。作り直すときは --rotate、止めるときは --off を使ってください");
  }
  if (before.cron_active !== true) fail("cron（routine-lab-dispatch-push）が有効ではありません");
  console.log("\n[設定]");
  cancelOverdue();
  createVaultCronSecret();
  copySecretToFunction();
  const mid = readState();
  if (!mid.match) fail("合言葉が一致しないため、send_push_url は作らずに止めます（経路は停止のまま）");
  createSendPushUrl();
} else if (mode === "off") {
  console.log("\n[停止]");
  deleteSendPushUrl();
} else if (mode === "on") {
  if (!before.match) fail("合言葉が一致していないため再開しません（--rotate で作り直してください）");
  console.log("\n[再開]");
  cancelOverdue();
  createSendPushUrl();
} else if (mode === "rotate") {
  if (!before.vault_cron_secret) fail("Vault に cron_secret がありません（初回は --apply）");
  console.log("\n[合言葉の作り直し]");
  deleteSendPushUrl(); // 作り直しの間に不一致の呼び出しが起きないよう、先に止める
  rotateVaultCronSecret();
  copySecretToFunction();
  if (!readState().match) fail("合言葉が一致しないため、停止のままにします");
  cancelOverdue();
  createSendPushUrl();
}

let verified = true;
if (mode !== "off") verified = await verify();
printState(readState(), "変更後の状態");
if (!verified) {
  console.log("\n確認が通りませんでした。止めるときは: node scripts/setup-cron-secret.mjs --off");
  process.exit(1);
}
}

try {
  await main();
} catch (e) {
  if (!(e instanceof SetupError)) throw e;
  console.error(`setup-cron-secret: ${e.message}`);
  process.exitCode = 1;
}
