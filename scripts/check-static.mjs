// 静的出力で使えない機能の混入を、ビルド前に検出する（docs/plan.md 6章：課題①の再発防止）。
// npm run build の prebuild で自動実行される。問題があれば終了コード 1。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const APP = join(SRC, "app");

/** ソースの1ファイルに対する検査。見つかった問題の説明を返す（テストから使う） */
export function checkSource(relPath, text) {
  const problems = [];
  const rules = [
    [/^\s*["']use server["']/m, "Server Actions（\"use server\"）は静的出力で使えません"],
    [/from\s+["']next\/headers["']/, "next/headers（cookies / headers）は静的出力で使えません"],
    [/from\s+["']next\/image["']/, "next/image は使いません（最適化が静的出力で動かないため）"],
    [/export\s+const\s+revalidate\s*=/, "revalidate（ISR）は静的出力で使えません"],
    [/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/, "dynamic = 'force-dynamic' は使えません"],
    [/export\s+(async\s+)?function\s+generateStaticParams/, "動的ルートは使わず、クエリ文字列（?id=）で渡します"],
    [/["']use cache["']/, "\"use cache\"（cacheComponents）は使いません"],
  ];
  for (const [re, msg] of rules) if (re.test(text)) problems.push(`${relPath}: ${msg}`);
  return problems;
}

/** next.config の検査 */
export function checkNextConfig(text) {
  const problems = [];
  if (!/output\s*:\s*["']export["']/.test(text)) problems.push("next.config: output: \"export\" がありません");
  if (!/trailingSlash\s*:\s*true/.test(text)) problems.push("next.config: trailingSlash: true がありません");
  if (!/unoptimized\s*:\s*true/.test(text)) problems.push("next.config: images.unoptimized: true がありません");
  const banned = ["cacheComponents", "partialPrefetching", "ppr", "rewrites", "redirects", "headers", "experimental"];
  // コメント行を除いてから調べる
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const key of banned) {
    if (new RegExp(`\\b${key}\\s*[:(]`).test(code)) problems.push(`next.config: ${key} は静的出力では使いません`);
  }
  return problems;
}

/** ファイル・フォルダ構成の検査（app 配下の相対パス一覧を受け取る） */
export function checkAppPaths(paths) {
  const problems = [];
  for (const p of paths) {
    const parts = p.split(/[\\/]/);
    const name = parts[parts.length - 1];
    if (/^route\.(t|j)sx?$/.test(name)) problems.push(`${p}: Route Handler は静的出力で使えません`);
    if (parts.some((s) => s.startsWith("[") || s.startsWith("(.") || s.startsWith("@"))) {
      problems.push(`${p}: 動的ルート・インターセプト・並列ルートは使いません（?id= で渡す）`);
    }
  }
  return problems;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function main() {
  const problems = [];
  for (const f of ["middleware.ts", "middleware.js", "proxy.ts", "proxy.js"]) {
    if (existsSync(join(ROOT, f)) || existsSync(join(SRC, f))) {
      problems.push(`${f}: Middleware / Proxy は静的出力で使えません`);
    }
  }
  const configPath = ["next.config.ts", "next.config.mjs", "next.config.js"].map((f) => join(ROOT, f)).find(existsSync);
  if (!configPath) problems.push("next.config が見つかりません");
  else problems.push(...checkNextConfig(readFileSync(configPath, "utf8")));

  if (existsSync(SRC)) {
    const files = walk(SRC);
    problems.push(...checkAppPaths(files.filter((f) => f.startsWith(APP + sep)).map((f) => relative(ROOT, f))));
    for (const f of files.filter((f) => /\.(t|j)sx?$/.test(f))) {
      problems.push(...checkSource(relative(ROOT, f), readFileSync(f, "utf8")));
    }
  }

  if (problems.length) {
    console.error("check-static: 静的出力で使えない設定・機能が見つかりました");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("check-static: OK");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
