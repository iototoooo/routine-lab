// 送信 API の守り（docs/plan.md 4.1 節）。純粋関数だけを置き、単体テストする。

const enc = new TextEncoder();

/** 長さに依存しない比較（秘密の値の比較に使う）。空の秘密は常に不一致にする */
export function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = enc.encode(a);
  const y = enc.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** "Bearer xxx" からトークンを取り出す */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

/**
 * CORS で許可するオリジンか。allowList はカンマ区切り。
 * "https://*.routine-lab.pages.dev" のように、先頭のサブドメイン1段だけワイルドカードを使える。
 */
export function isAllowedOrigin(origin: string | null, allowList: string): boolean {
  if (!origin) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  for (const raw of allowList.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!raw.includes("*")) {
      if (raw === o.origin) return true;
      continue;
    }
    const m = /^(https?):\/\/\*\.([^/*]+)$/.exec(raw);
    const scheme = m?.[1];
    const base = m?.[2];
    if (!scheme || !base) continue;
    if (o.protocol !== `${scheme}:`) continue;
    const host = o.host;
    if (!host.endsWith(`.${base}`)) continue;
    const sub = host.slice(0, -(base.length + 1));
    if (sub && !sub.includes(".")) return true;
  }
  return false;
}

export function corsHeaders(origin: string | null, allowList: string): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    // supabase-js 2.118 が送るヘッダー（@supabase/supabase-js/cors の一覧と同じ）
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (origin && isAllowedOrigin(origin, allowList)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

/** ログに出すときは endpoint の末尾だけにする（端末を特定できる値をログに残さない） */
export function maskEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `${u.host}/…${endpoint.slice(-6)}`;
  } catch {
    return "…";
  }
}

export type TestPushRequest = { mode: "now" } | { mode: "delayed"; delaySeconds: 60 | 120 | 300 };

/**
 * テスト送信の依頼を検証する。宛先・文面・user_id は受け付けない（本人の端末へ固定文面だけ）。
 */
export function parseTestPushRequest(body: unknown): TestPushRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.mode === "now") return { mode: "now" };
  if (b.mode === "delayed") {
    const d = b.delaySeconds ?? 60;
    if (d === 60 || d === 120 || d === 300) return { mode: "delayed", delaySeconds: d };
  }
  return null;
}

/**
 * 送信してよいプッシュサービスの URL か（SSRF 対策）。
 * push_subscriptions の endpoint は利用者が登録できるため、任意のサーバーへ送らないよう、
 * ブラウザの標準プッシュサービスの https URL だけに限る。
 */
const PUSH_HOSTS_EXACT = new Set([
  "fcm.googleapis.com", // Chrome / Android / Edge(新)
  "updates.push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari / iOS
]);
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS_EXACT.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * Edge Function の環境変数から管理用キーを選ぶ。
 * 新しい API キー（SUPABASE_SECRET_KEYS：{"default":"sb_secret_..."} 形式の JSON）を優先し、
 * なければ旧方式の SUPABASE_SERVICE_ROLE_KEY を使う。値はログに出さない。
 */
export function pickServiceKey(secretKeysJson: string | undefined, legacyKey: string | undefined): string | null {
  if (secretKeysJson) {
    try {
      const parsed: unknown = JSON.parse(secretKeysJson);
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>;
        const v = rec.default ?? Object.values(rec)[0];
        if (typeof v === "string" && v) return v;
      }
    } catch {
      // 壊れていれば旧方式へ
    }
  }
  return legacyKey || null;
}
