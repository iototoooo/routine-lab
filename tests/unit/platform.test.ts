import { describe, expect, it } from "vitest";
import webpushLib from "web-push";
import {
  describeDevice,
  isIOSUserAgent,
  pushReadiness,
  urlBase64ToUint8Array,
} from "@/lib/push/platform";
import { safeNextPath } from "@/lib/nav";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

const full = { hasServiceWorker: true, hasPushManager: true, hasNotification: true };

describe("isIOSUserAgent", () => {
  it("iPhone と、デスクトップ表示の iPad（タッチあり）を iOS と判定する", () => {
    expect(isIOSUserAgent(IPHONE)).toBe(true);
    expect(isIOSUserAgent(IPAD_DESKTOP, 5)).toBe(true);
    expect(isIOSUserAgent(IPAD_DESKTOP, 0)).toBe(false); // Mac
    expect(isIOSUserAgent(ANDROID)).toBe(false);
  });
});

describe("pushReadiness", () => {
  it("iPhone でホーム画面から起動していなければ、追加の案内を出す", () => {
    expect(pushReadiness({ isIOS: true, isStandalone: false, ...full })).toEqual({ kind: "ios-needs-home-screen" });
    expect(pushReadiness({ isIOS: true, isStandalone: true, ...full })).toEqual({ kind: "ready" });
  });
  it("Android / PC はブラウザのままでも使える。API がなければ非対応", () => {
    expect(pushReadiness({ isIOS: false, isStandalone: false, ...full })).toEqual({ kind: "ready" });
    expect(pushReadiness({ isIOS: false, isStandalone: false, ...full, hasPushManager: false })).toEqual({
      kind: "unsupported",
    });
  });
});

describe("urlBase64ToUint8Array", () => {
  it("VAPID 公開鍵（87文字）を 65 バイトに変換する", () => {
    const key = webpushLib.generateVAPIDKeys().publicKey;
    const bytes = urlBase64ToUint8Array(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });
});

describe("describeDevice", () => {
  it("端末の種類を短く表示する", () => {
    expect(describeDevice(IPHONE)).toBe("iPhone");
    expect(describeDevice(ANDROID)).toBe("Android");
    expect(describeDevice(EDGE)).toBe("PC（Edge）");
    expect(describeDevice(null)).toBe("不明な端末");
  });
});

describe("safeNextPath", () => {
  it("同じサイト内のパスだけを許す", () => {
    expect(safeNextPath("/record/?o=1")).toBe("/record/?o=1");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("/login/")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });
});
