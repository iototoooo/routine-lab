// 秘密情報の混入を検出する（docs/plan.md 4.1 節）。
//   node scripts/check-secrets.mjs          … リポジトリ内のファイル（git 管理下、なければ除外以外すべて）
//   node scripts/check-secrets.mjs out      … 指定フォルダ（ビルド結果など）
// 見つかった値そのものは表示しない（場所と種類だけを表示する）。
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", "out", ".git", ".temp", "test-results", "playwright-report", "coverage"]);
const SKIP_FILES = new Set(["package-lock.json"]);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|toml|sql|yml|yaml|txt|html|css|env|example|webmanifest|map|sh|ps1)$|^\.env|^_headers$|^\.gitignore$/;

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** 文字列から秘密情報らしいものを探す。種類の一覧を返す（値は返さない） */
export function scanText(text) {
  const found = [];
  // service_role の JWT（anon の JWT は公開してよいので除外）
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g)) {
    const payload = decodeJwtPayload(m[0]);
    if (payload && payload.role && payload.role !== "anon") found.push(`JWT（role=${payload.role}）`);
  }
  const rules = [
    [/sb_secret_[A-Za-z0-9_-]{10,}/, "Supabase の secret キー（sb_secret_）"],
    [/sbp_[A-Za-z0-9]{20,}/, "Supabase のアクセストークン（sbp_）"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "秘密鍵（PEM）"],
    [/VAPID_PRIVATE_KEY\s*[=:]\s*["']?[A-Za-z0-9_-]{40,}/, "VAPID 秘密鍵の値"],
    [/SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*["']?[A-Za-z0-9_.-]{40,}/, "service_role キーの値"],
    [/CRON_SECRET\s*[=:]\s*["']?[A-Za-z0-9_-]{24,}/, "CRON_SECRET の値"],
    [/"d"\s*:\s*"[A-Za-z0-9_-]{43}"/, "JWK の秘密鍵（d）"],
    [/postgres(ql)?:\/\/[^:\s]+:[^@\s]{6,}@/, "DB 接続文字列（パスワード付き）"],
  ];
  for (const [re, label] of rules) if (re.test(text)) found.push(label);
  return found;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(p));
    } else if (!SKIP_FILES.has(name)) out.push(p);
  }
  return out;
}

function repoFiles() {
  try {
    const listed = execSync("git ls-files -co --exclude-standard", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((f) => join(ROOT, f));
    if (listed.length) return listed.filter((f) => existsSync(f) && !SKIP_FILES.has(f.split(/[\\/]/).pop()));
  } catch {
    // git がまだない場合は下のフォルダ走査
  }
  return walk(ROOT);
}

export function scanFiles(files, baseDir = ROOT) {
  const problems = [];
  for (const f of files) {
    const name = f.split(/[\\/]/).pop() ?? "";
    if (!TEXT_EXT.test(name)) continue;
    if (/^\.env/.test(name) && name !== ".env.example") {
      problems.push(`${relative(baseDir, f)}: .env ファイルは Git に含めません`);
      continue;
    }
    if (statSync(f).size > 5_000_000) continue;
    for (const label of scanText(readFileSync(f, "utf8"))) problems.push(`${relative(baseDir, f)}: ${label}`);
  }
  return problems;
}

function main() {
  const target = process.argv[2];
  let files;
  if (target) {
    const dir = join(ROOT, target);
    if (!existsSync(dir)) {
      console.error(`check-secrets: ${target} がありません`);
      process.exit(1);
    }
    files = walk(dir);
  } else {
    // .env.local などは .gitignore 済みなので、git 管理下のファイルだけを調べる
    files = repoFiles();
  }
  const problems = scanFiles(files);
  if (problems.length) {
    console.error("check-secrets: 秘密情報の可能性があるものが見つかりました（値は表示しません）");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`check-secrets: OK（${target ?? "リポジトリ"}、${files.length} ファイル）`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
