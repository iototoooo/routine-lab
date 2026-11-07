// ビルド結果（out/）の確認（docs/plan.md 6章）。npm run build の postbuild で自動実行される。
//  - 必要なページの HTML と PWA のファイルが揃っているか
//  - 秘密情報が含まれていないか
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanFiles } from "./check-secrets.mjs";

const OUT = join(process.cwd(), "out");
const REQUIRED = [
  "index.html",
  "login/index.html",
  "record/index.html",
  "settings/index.html",
  "routines/index.html",
  "routines/edit/index.html",
  "routines/detail/index.html",
  "404.html",
  "sw.js",
  "manifest.webmanifest",
  "_headers",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const problems = [];
if (!existsSync(OUT)) {
  console.error("check-out: out/ がありません（output: \"export\" になっているか確認）");
  process.exit(1);
}
for (const f of REQUIRED) if (!existsSync(join(OUT, f))) problems.push(`out/${f} がありません`);
problems.push(...scanFiles(walk(OUT), process.cwd()));

if (problems.length) {
  console.error("check-out: ビルド結果に問題があります");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("check-out: OK");
