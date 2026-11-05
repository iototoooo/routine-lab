// Web Push の暗号化（RFC 8291, aes128gcm）と VAPID 署名（RFC 8292, ES256）。
// WebCrypto だけで実装しているため、Supabase Edge Functions（Deno）と Node（Vitest）の両方で動く。
// 外部ライブラリに頼らないので、Deno の npm 互換性の問題を避けられ、単体テストで暗号文を検証できる。

type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();

export function b64urlToBytes(s: string): Bytes {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function concat(...parts: Uint8Array[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export type PushSubscriptionKeys = {
  endpoint: string;
  p256dh: string; // base64url, 65 bytes (非圧縮の公開鍵)
  auth: string; // base64url, 16 bytes
};

export type EncryptOptions = {
  /** テスト用：salt を固定する */
  salt?: Bytes;
  /** テスト用：送信側の一時鍵を固定する */
  serverKeyPair?: CryptoKeyPair;
  /** レコードサイズ（既定 4096） */
  recordSize?: number;
};

/** RFC 8291 に従ってペイロードを暗号化し、aes128gcm の本文（ヘッダー付き）を返す */
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublicB64: string,
  authSecretB64: string,
  opts: EncryptOptions = {},
): Promise<Bytes> {
  const uaPublic = b64urlToBytes(uaPublicB64);
  const authSecret = b64urlToBytes(authSecretB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("invalid p256dh");
  if (authSecret.length !== 16) throw new Error("invalid auth secret");

  const recordSize = opts.recordSize ?? 4096;
  // 1レコードに収める：平文＋区切り(1)＋タグ(16) <= rs
  if (plaintext.length + 17 > recordSize) throw new Error("payload too large");

  const serverKeys =
    opts.serverKeyPair ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, serverKeys.privateKey, 256),
  );

  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([0x02])); // 最後のレコードの区切り
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, padded),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export type VapidKeys = {
  publicKey: string; // base64url, 65 bytes
  privateKey: string; // base64url, 32 bytes (d)
  subject: string; // "mailto:..." または "https://..."
};

/** VAPID の Authorization ヘッダー値を作る（有効期限は最大 24 時間。既定 12 時間） */
export async function vapidAuthorization(
  endpoint: string,
  vapid: VapidKeys,
  now: Date = new Date(),
  ttlSeconds = 12 * 60 * 60,
): Promise<string> {
  const pub = b64urlToBytes(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("invalid VAPID public key");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: vapid.privateKey,
    ext: false,
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64url(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now.getTime() / 1000) + ttlSeconds,
        sub: vapid.subject,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  // WebCrypto の ECDSA 署名は r||s（64 バイト）で、JWS の形式そのもの
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput)),
  );
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${vapid.publicKey}`;
}

export type PushRequest = {
  url: string;
  headers: Record<string, string>;
  body: Bytes;
};

/** 送信する HTTP リクエストを組み立てる（送信そのものは呼び出し側の fetch で行う） */
export async function buildPushRequest(
  sub: PushSubscriptionKeys,
  payload: unknown,
  vapid: VapidKeys,
  opts: { ttlSeconds?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string } = {},
): Promise<PushRequest> {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(sub.endpoint, vapid),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(opts.ttlSeconds ?? 3600),
    Urgency: opts.urgency ?? "high",
  };
  // Topic を付けると、配送待ちの古いメッセージが同じ Topic の新しいもので置き換わる（最大32文字の URL 安全文字）
  if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return { url: sub.endpoint, headers, body };
}
