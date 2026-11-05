// 端末・ブラウザの判定（UI から切り離した純粋関数。テスト対象）

export type PushEnvironment = {
  isIOS: boolean;
  isStandalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
};

export function isIOSUserAgent(ua: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS 13 以降のデスクトップ表示は "Macintosh" を名乗るため、タッチ点数で判別する
  return /Macintosh/i.test(ua) && maxTouchPoints > 1;
}

export type PushReadiness =
  | { kind: "ready" }
  | { kind: "ios-needs-home-screen" }
  | { kind: "unsupported" };

/** 通知を使える状態か。iPhone はホーム画面に追加したアプリでのみ使える（F-303） */
export function pushReadiness(env: PushEnvironment): PushReadiness {
  if (env.isIOS && !env.isStandalone) return { kind: "ios-needs-home-screen" };
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
    return { kind: "unsupported" };
  }
  return { kind: "ready" };
}

/** VAPID 公開鍵（base64url）を PushManager.subscribe 用のバイト列にする */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** 端末一覧に表示する短い名前（user_agent から推定） */
export function describeDevice(ua: string | null): string {
  if (!ua) return "不明な端末";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Edg\//i.test(ua)) return "PC（Edge）";
  if (/Firefox\//i.test(ua)) return "PC（Firefox）";
  if (/Chrome\//i.test(ua)) return "PC（Chrome）";
  if (/Safari\//i.test(ua)) return "Mac（Safari）";
  return "その他の端末";
}
