#!/usr/bin/env node
// ブラウザテスト用のビルド。接続先を「存在しない偽の Supabase」にして out/ を作る。
// テストでは、この宛先への通信をすべて Playwright が横取りして偽の応答を返す（本番の DB・メールは使わない）。
// ※ ここで作る out/ はテスト専用。公開は Cloudflare Pages 側のビルドだけ（CLAUDE.md）。

import { spawnSync } from "node:child_process";

const r = spawnSync("npm run build", {
  shell: true,
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: "https://e2e-test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon-key",
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: "e2e-vapid-public-key",
  },
});
process.exit(r.status ?? 1);
