import { describe, expect, it } from "vitest";
import { checkAppPaths, checkNextConfig, checkSource } from "../../scripts/check-static.mjs";
import { scanText } from "../../scripts/check-secrets.mjs";

function fakeJwt(payload: object): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256", typ: "JWT" })}.${b(payload)}.c2lnbmF0dXJlc2lnbmF0dXJl`;
}

describe("check-static", () => {
  it("課題①の失敗設定（cacheComponents / partialPrefetching）を検出する", () => {
    const bad = `const nextConfig = { cacheComponents: true, partialPrefetching: true };`;
    const problems: string[] = checkNextConfig(bad);
    expect(problems.some((p) => p.includes("output"))).toBe(true);
    expect(problems.some((p) => p.includes("cacheComponents"))).toBe(true);
    expect(problems.some((p) => p.includes("partialPrefetching"))).toBe(true);
  });
  it("正しい設定は通る（コメント内の語は無視）", () => {
    const good = `// cacheComponents: true は使わない
      const c = { output: "export", trailingSlash: true, images: { unoptimized: true } };`;
    expect(checkNextConfig(good)).toEqual([]);
  });
  it("Server Actions・next/headers・動的ルート・Route Handler を検出する", () => {
    expect(checkSource("a.ts", `"use server";\nexport async function f() {}`)).toHaveLength(1);
    expect(checkSource("b.ts", `import { cookies } from "next/headers";`)).toHaveLength(1);
    expect(checkSource("c.tsx", `"use client";\nexport default function P() {}`)).toEqual([]);
    expect(checkAppPaths(["src/app/routines/[id]/page.tsx"])).toHaveLength(1);
    expect(checkAppPaths(["src/app/api/hello/route.ts"])).toHaveLength(1);
    expect(checkAppPaths(["src/app/routines/edit/page.tsx"])).toEqual([]);
  });
});

// 検出パターンの文字列は分割して書く（このテストファイル自体が検出されないように）
describe("check-secrets", () => {
  it("service_role の JWT は検出し、anon の JWT は公開値として通す", () => {
    expect(scanText(`key=${fakeJwt({ role: "service_role", iss: "supabase" })}`)).toEqual([
      "JWT（role=service_role）",
    ]);
    expect(scanText(`key=${fakeJwt({ role: "anon", iss: "supabase" })}`)).toEqual([]);
  });
  it("秘密鍵・secret キー・値の入った環境変数を検出する", () => {
    expect(scanText("sb_" + "secret_abcdefghijklmnopqrstuvwxyz").length).toBe(1);
    expect(scanText("-----BEGIN " + "PRIVATE KEY-----").length).toBe(1);
    expect(scanText("VAPID_PRIVATE_KEY" + "=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ").length).toBe(1);
    expect(scanText("postgresql://postgres:" + "supersecretpw@db.example.co:5432/postgres").length).toBe(1);
  });
  it("変数名だけ（値なし）や公開鍵は検出しない", () => {
    expect(scanText("VAPID_PRIVATE_KEY=")).toEqual([]);
    expect(scanText('requireEnv("VAPID_PRIVATE_KEY")')).toEqual([]);
    expect(scanText("sb_publishable_abcdefghijklmnop")).toEqual([]);
  });
});
