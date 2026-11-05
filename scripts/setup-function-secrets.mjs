#!/usr/bin/env node
// Edge Function の Secrets を登録する（docs/plan.md 4.1 節「秘密情報の置き場所」）。
//
// 守っていること：
//  - VAPID 鍵はこのプロセスの中で生成し、秘密鍵は画面・ログ・リポジトリに一切出さない
//  - supabase CLI へは一時ファイル（OS の一時フォルダ、所有者のみ読み書き）で渡し、終了時に必ず削除する
//    （コマンドライン引数に載せないので、シェルの履歴やプロセス一覧にも残らない）
//  - 対象は routine-lab（ref を固定）だけ。既に VAPID_PRIVATE_KEY があれば --rotate なしでは止まる
//    （鍵を作り直すと、登録済みの端末はすべて購読し直しが必要になるため）
//  - CRON_SECRET はここでは登録しない（cron の送信を有効にする段階で Vault と同時に登録する）
//  - 画面に出すのは公開値（VAPID 公開鍵）と、登録した名前だけ
//
// 使い方：
//   node scripts/setup-function-secrets.mjs --subject mailto:you@example.com [--origins http://localhost:3000,https://xxx.pages.dev] [--dry-run]
//   --dry-run：鍵を作って一時ファイルの作成・削除まで確認し、Supabase には何も送らない

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";

const PROJECT_REF = "vmlxzeraeimxgkjxivnl"; // routine-lab（Practice には触れない）

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const rotate = args.includes("--rotate");
const subject = opt("--subject");
const origins = opt("--origins") ?? "http://localhost:3000";

function fail(msg) {
  console.error(`setup-function-secrets: ${msg}`);
  process.exit(1);
}

if (!subject || !/^(mailto:[^@\s]+@[^@\s]+\.[^@\s]+|https:\/\/[^\s]+)$/.test(subject)) {
  fail("--subject に mailto:アドレス または https://URL を指定してください（Apple の通知サービスが確認します）");
}
for (const o of origins.split(",").map((s) => s.trim()).filter(Boolean)) {
  if (!/^https?:\/\/(\*\.)?[A-Za-z0-9.-]+(:\d+)?$/.test(o)) fail(`--origins の形式が正しくありません: ${o}`);
}

function supabase(cliArgs, { capture = false } = {}) {
  // Windows では npx がバッチファイルなので shell を使う。引数に秘密の値は含めない
  // 引数は固定値と一時ファイルのパスだけ（空白・記号を含まないことを確認してから1つの文字列にする）
  if (cliArgs.some((a) => !/^[A-Za-z0-9_.:=/\\-]+$/.test(a))) fail("想定外の引数です");
  const r = spawnSync(`npx supabase ${cliArgs.join(" ")}`, {
    shell: true,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (r.status !== 0) fail(`supabase ${cliArgs[0]} ${cliArgs[1] ?? ""} が失敗しました（終了コード ${r.status}）`);
  return r.stdout ?? "";
}

function existingSecretNames() {
  const out = supabase(["secrets", "list", `--remote=${PROJECT_REF}`, "-o", "json"], { capture: true });
  const start = out.search(/[[{]/);
  if (start < 0) return [];
  const j = JSON.parse(out.slice(start));
  const arr = Array.isArray(j) ? j : (Object.values(j).find(Array.isArray) ?? []);
  return arr.map((x) => x?.name).filter(Boolean);
}

if (!dryRun) {
  const names = existingSecretNames();
  if (names.includes("VAPID_PRIVATE_KEY") && !rotate) {
    fail("VAPID_PRIVATE_KEY は登録済みです。作り直す場合だけ --rotate を付けてください（端末の購読し直しが必要になります）");
  }
}

const keys = webpush.generateVAPIDKeys();
const secrets = {
  VAPID_PUBLIC_KEY: keys.publicKey,
  VAPID_PRIVATE_KEY: keys.privateKey,
  VAPID_SUBJECT: subject,
  ALLOWED_ORIGINS: origins,
};

const dir = mkdtempSync(join(tmpdir(), "routine-lab-secrets-"));
const file = join(dir, "functions.env");
try {
  writeFileSync(file, Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  if (dryRun) {
    const written = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => l.split("=")[0]);
    console.log(`[dry-run] 一時ファイルに書いた名前: ${written.join(", ")}（値は表示しません）`);
  } else {
    supabase(["secrets", "set", "--env-file", file, `--remote=${PROJECT_REF}`, "--yes"]);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (existsSync(file)) fail("一時ファイルを削除できませんでした。手動で削除してください: " + dir);
console.log(`一時ファイルを削除しました（${dryRun ? "dry-run" : "登録後"}）`);

// 公開値だけを .env.local に書く（.env* は Git の対象外）
if (!dryRun) {
  const path = ".env.local";
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const set = (k, v) => {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  };
  set("NEXT_PUBLIC_SUPABASE_URL", `https://${PROJECT_REF}.supabase.co`);
  set("NEXT_PUBLIC_VAPID_PUBLIC_KEY", keys.publicKey);
  // publishable キー（公開値）だけを取り出す。一覧には秘密のキーも含まれるため、他の値は表示も保存もしない
  const raw = supabase(["projects", "api-keys", `--remote=${PROJECT_REF}`, "-o", "json"], { capture: true });
  const start = raw.search(/[[{]/);
  const list = start >= 0 ? JSON.parse(raw.slice(start)) : [];
  const arr = Array.isArray(list) ? list : (Object.values(list).find(Array.isArray) ?? []);
  const publishable = arr.find((k) => k?.type === "publishable")?.api_key;
  if (typeof publishable === "string" && publishable.startsWith("sb_publishable_")) {
    set("NEXT_PUBLIC_SUPABASE_ANON_KEY", publishable);
  } else {
    console.log("publishable キーが見つかりませんでした。ダッシュボードの API Keys から .env.local に手で書いてください");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  writeFileSync(path, lines.join("\n") + "\n");
  console.log(".env.local に公開値（URL・publishable キー・VAPID 公開鍵）を書きました");
}

console.log(`${dryRun ? "[dry-run] 登録する予定の" : "登録した"} Secrets: ${Object.keys(secrets).join(", ")}`);
console.log(`VAPID 公開鍵（公開値。Cloudflare Pages の NEXT_PUBLIC_VAPID_PUBLIC_KEY に使う）: ${keys.publicKey}`);
