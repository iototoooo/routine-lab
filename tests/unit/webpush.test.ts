import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import webpushLib from "web-push";
import {
  b64urlToBytes,
  buildPushRequest,
  bytesToB64url,
  encryptPayload,
  vapidAuthorization,
} from "../../supabase/functions/_shared/webpush.ts";

// http_ece は web-push が内部で使う、Web Push 暗号化の参照実装（受信側の復号に使う）
const require = createRequire(import.meta.url);
const ece = require("http_ece") as {
  decrypt(buf: Buffer, params: { version: string; privateKey: unknown; authSecret: Buffer }): Buffer;
};

function makeSubscriber() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  return {
    ecdh,
    authSecret,
    p256dh: bytesToB64url(ecdh.getPublicKey()),
    auth: bytesToB64url(authSecret),
  };
}

describe("base64url", () => {
  it("往復で同じバイト列に戻る", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(b64urlToBytes(bytesToB64url(bytes)))).toEqual(Array.from(bytes));
    expect(bytesToB64url(bytes)).not.toMatch(/[+/=]/);
  });
});

describe("encryptPayload（RFC 8291 aes128gcm）", () => {
  it("参照実装（http_ece）で復号でき、元の文面に戻る", async () => {
    const sub = makeSubscriber();
    const text = JSON.stringify({ title: "朝のストレッチ", body: "7:00〜 15分", tag: "abc" });
    const body = await encryptPayload(new TextEncoder().encode(text), sub.p256dh, sub.auth);
    const plain = ece.decrypt(Buffer.from(body), {
      version: "aes128gcm",
      privateKey: sub.ecdh,
      authSecret: sub.authSecret,
    });
    expect(plain.toString("utf8")).toBe(text);
  });

  it("ヘッダーは salt(16) + rs(4) + idlen(1)=65 + 送信側公開鍵(65)", async () => {
    const sub = makeSubscriber();
    const body = await encryptPayload(new TextEncoder().encode("x"), sub.p256dh, sub.auth);
    const view = new DataView(body.buffer);
    expect(view.getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(0x04);
    // 平文1 + 区切り1 + タグ16
    expect(body.length).toBe(86 + 1 + 1 + 16);
  });

  it("毎回 salt と一時鍵が変わる（同じ文面でも暗号文が異なる）", async () => {
    const sub = makeSubscriber();
    const a = await encryptPayload(new TextEncoder().encode("same"), sub.p256dh, sub.auth);
    const b = await encryptPayload(new TextEncoder().encode("same"), sub.p256dh, sub.auth);
    expect(bytesToB64url(a)).not.toBe(bytesToB64url(b));
  });

  it("不正な鍵や大きすぎる文面は拒否する", async () => {
    const sub = makeSubscriber();
    await expect(encryptPayload(new Uint8Array(1), "AAAA", sub.auth)).rejects.toThrow();
    await expect(encryptPayload(new Uint8Array(1), sub.p256dh, "AAAA")).rejects.toThrow();
    await expect(encryptPayload(new Uint8Array(5000), sub.p256dh, sub.auth)).rejects.toThrow(
      "payload too large",
    );
  });
});

describe("vapidAuthorization（RFC 8292 ES256）", () => {
  const keys = webpushLib.generateVAPIDKeys();
  const vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:test@example.com" };

  it("公開鍵で署名を検証でき、aud・exp・sub が正しい", async () => {
    const now = new Date("2026-11-05T00:00:00Z");
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", vapid, now);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, jwt, k] = m!;
    expect(k).toBe(keys.publicKey);

    const [h, p, s] = jwt!.split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString("utf8"));
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.sub).toBe("mailto:test@example.com");
    expect(payload.exp).toBe(Math.floor(now.getTime() / 1000) + 12 * 3600);

    const pub = Buffer.from(keys.publicKey, "base64url");
    const key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") },
      format: "jwk",
    });
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(s!, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("別の鍵の公開鍵では検証できない", async () => {
    const other = webpushLib.generateVAPIDKeys();
    const header = await vapidAuthorization("https://web.push.apple.com/x", vapid);
    const jwt = /t=([^,]+)/.exec(header)![1]!;
    const [h, p, s] = jwt.split(".");
    const pub = Buffer.from(other.publicKey, "base64url");
    const key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") },
      format: "jwk",
    });
    expect(
      verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")),
    ).toBe(false);
  });
});

describe("buildPushRequest", () => {
  it("必要なヘッダーが揃い、Topic は URL 安全な32文字以内になる", async () => {
    const sub = makeSubscriber();
    const keys = webpushLib.generateVAPIDKeys();
    const req = await buildPushRequest(
      { endpoint: "https://web.push.apple.com/abc", p256dh: sub.p256dh, auth: sub.auth },
      { title: "t" },
      { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:a@example.com" },
      { ttlSeconds: 600, topic: "test-0b6f4f0e-1c2d-4e5f-8a9b-0123456789ab" },
    );
    expect(req.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(req.headers.TTL).toBe("600");
    expect(req.headers.Urgency).toBe("high");
    expect(req.headers.Topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(req.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
  });
});
