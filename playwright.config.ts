import { defineConfig, devices } from "@playwright/test";

// ブラウザテスト（docs/phase1-plan.md 5章）。`npm run test:e2e` で、偽の接続先でビルド → out/ を配信 → 実行。
// Supabase への通信は tests/e2e/fake-supabase.ts がすべて横取りする（外部には出ない）。
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    serviceWorkers: "block",
  },
  projects: [
    { name: "chromium-mobile", use: { ...devices["Pixel 7"] } },
    { name: "webkit-iphone", use: { ...devices["iPhone 14"] } },
  ],
  webServer: {
    command: "node scripts/serve-out.mjs",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: !process.env.CI,
  },
});
