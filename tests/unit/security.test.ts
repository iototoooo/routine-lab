import { describe, expect, it } from "vitest";
import {
  bearerToken,
  corsHeaders,
  isAllowedOrigin,
  isAllowedPushEndpoint,
  maskEndpoint,
  parseTestPushRequest,
  pickServiceKey,
  timingSafeEqual,
} from "../../supabase/functions/_shared/security.ts";

describe("timingSafeEqual", () => {
  it("一致・不一致・長さ違い・空を正しく判定する", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
    expect(timingSafeEqual("abc", "abc123")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(false); // 秘密が未設定なら常に拒否
    expect(timingSafeEqual("x", "")).toBe(false);
  });
});

describe("bearerToken", () => {
  it("Bearer の形式だけを受け付ける", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("isAllowedOrigin", () => {
  const list = "https://routine-lab.pages.dev, https://*.routine-lab.pages.dev, http://localhost:3000";
  it("完全一致とサブドメイン1段のワイルドカードを許可する", () => {
    expect(isAllowedOrigin("https://routine-lab.pages.dev", list)).toBe(true);
    expect(isAllowedOrigin("https://abc123.routine-lab.pages.dev", list)).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", list)).toBe(true);
  });
  it("似たドメイン・多段・スキーム違いは拒否する", () => {
    expect(isAllowedOrigin("https://evil-routine-lab.pages.dev", list)).toBe(false);
    expect(isAllowedOrigin("https://a.b.routine-lab.pages.dev", list)).toBe(false);
    expect(isAllowedOrigin("http://abc.routine-lab.pages.dev", list)).toBe(false);
    expect(isAllowedOrigin("https://routine-lab.pages.dev.evil.com", list)).toBe(false);
    expect(isAllowedOrigin(null, list)).toBe(false);
    expect(isAllowedOrigin("https://routine-lab.pages.dev", "")).toBe(false);
  });
  it("許可しないオリジンには Allow-Origin を付けない", () => {
    expect(corsHeaders("https://evil.example", list)["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeaders("https://routine-lab.pages.dev", list)["Access-Control-Allow-Origin"]).toBe(
      "https://routine-lab.pages.dev",
    );
  });
});

describe("maskEndpoint", () => {
  it("ホストと末尾6文字だけを残す", () => {
    expect(maskEndpoint("https://fcm.googleapis.com/fcm/send/abcdefghijklmnop")).toBe(
      "fcm.googleapis.com/…klmnop",
    );
    expect(maskEndpoint("not a url")).toBe("…");
  });
});

describe("parseTestPushRequest", () => {
  it("決められたモードと遅延だけを受け付ける", () => {
    expect(parseTestPushRequest({ mode: "now" })).toEqual({ mode: "now" });
    expect(parseTestPushRequest({ mode: "delayed" })).toEqual({ mode: "delayed", delaySeconds: 60 });
    expect(parseTestPushRequest({ mode: "delayed", delaySeconds: 300 })).toEqual({
      mode: "delayed",
      delaySeconds: 300,
    });
  });
  it("宛先や文面の指定は無視し、不正な値は拒否する", () => {
    // user_id や endpoint を送っても、結果に含まれない（本人の端末へ固定文面だけ）
    expect(parseTestPushRequest({ mode: "now", user_id: "x", endpoint: "https://e", title: "t" })).toEqual({
      mode: "now",
    });
    expect(parseTestPushRequest({ mode: "delayed", delaySeconds: 1 })).toBeNull();
    expect(parseTestPushRequest({ mode: "delayed", delaySeconds: "60" })).toBeNull();
    expect(parseTestPushRequest({ mode: "spam" })).toBeNull();
    expect(parseTestPushRequest(null)).toBeNull();
    expect(parseTestPushRequest("now")).toBeNull();
  });
});

describe("isAllowedPushEndpoint", () => {
  it("標準のプッシュサービスだけ許可する", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/QAbc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://wns2-db5p.notify.windows.com/w/?token=x")).toBe(true);
  });
  it("それ以外・http・ポート指定・似せたホストは拒否する", () => {
    expect(isAllowedPushEndpoint("https://attacker.example/push")).toBe(false);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.attacker.example/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://evilnotify.windows.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://user:pw@fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
  });
});

describe("pickServiceKey", () => {
  it("新しい secret キーを優先し、なければ旧キー", () => {
    expect(pickServiceKey('{"default":"new-key"}', "legacy")).toBe("new-key");
    expect(pickServiceKey('{"other":"k2"}', "legacy")).toBe("k2");
    expect(pickServiceKey(undefined, "legacy")).toBe("legacy");
    expect(pickServiceKey("not json", "legacy")).toBe("legacy");
    expect(pickServiceKey("{}", undefined)).toBe(null);
  });
});

describe("corsHeaders", () => {
  it("supabase-js が送るヘッダーをすべて許可する", () => {
    const h = corsHeaders("http://localhost:3000", "http://localhost:3000");
    for (const name of ["authorization", "x-client-info", "apikey", "content-type", "x-retry-count", "traceparent", "tracestate", "baggage"]) {
      expect(h["Access-Control-Allow-Headers"]).toContain(name);
    }
    expect(h["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
    expect(corsHeaders("https://evil.example", "http://localhost:3000")["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});
