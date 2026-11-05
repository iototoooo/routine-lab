import { FunctionsHttpError } from "@supabase/supabase-js";
import { readPublicEnv } from "@/lib/env";
import { getSupabase } from "@/lib/supabase/client";
import { isIOSUserAgent, urlBase64ToUint8Array, type PushEnvironment } from "./platform";

// ブラウザ側の通知処理。送信は Edge Function だけが行い、ここでは購読の登録・解除と
// 本人のテスト送信の依頼だけを行う（docs/plan.md 4.1 節）。

export function detectPushEnvironment(): PushEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    isIOS: isIOSUserAgent(nav.userAgent, nav.maxTouchPoints ?? 0),
    isStandalone:
      nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches,
    hasServiceWorker: "serviceWorker" in nav,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
  };
}

function bytesToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 通知を許可して、この端末を登録する。
 * iOS ではユーザー操作の中で requestPermission を呼ぶ必要があるため、
 * ボタンのクリック処理から「最初に」呼ぶこと。
 */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "通知が拒否されています。端末の設定から許可してください。"
        : "通知が許可されませんでした。",
    );
  }
  const { vapidPublicKey } = readPublicEnv();
  if (!vapidPublicKey) throw new Error("VAPID 公開鍵が設定されていません。");

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  const supabase = getSupabase();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("ログインしてください。");

  // RLS で本人の行だけを登録・更新できる。ほかの人の端末は登録も閲覧もできない。
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: userData.user.id,
      endpoint: sub.endpoint,
      p256dh: bytesToBase64Url(sub.getKey("p256dh")),
      auth: bytesToBase64Url(sub.getKey("auth")),
      user_agent: navigator.userAgent.slice(0, 300),
      disabled_at: null,
    },
    { onConflict: "endpoint" },
  );
  if (error) {
    throw new Error(
      "端末の登録に失敗しました。この端末が別のアカウントで登録されている可能性があります。",
    );
  }
}

/** この端末の通知を解除する（購読を取り消し、DB 側も無効にする） */
export async function disablePushOnThisDevice(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  const { error } = await getSupabase()
    .from("push_subscriptions")
    .update({ disabled_at: new Date().toISOString() })
    .eq("endpoint", endpoint);
  if (error) throw new Error("端末の解除の記録に失敗しました。");
}

export async function currentEndpoint(): Promise<string | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

export type TestPushMode = "now" | "delayed";

export type TestPushResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/** 本人の端末へのテスト送信を依頼する（Edge Function test-push。JWT と回数制限で守られている） */
export async function requestTestPush(
  mode: TestPushMode,
  delaySeconds = 60,
): Promise<TestPushResult> {
  const { data, error } = await getSupabase().functions.invoke("test-push", {
    body: { mode, delaySeconds },
  });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const status = error.context.status;
      let detail = "";
      try {
        const body = (await error.context.json()) as { message?: string };
        detail = body.message ?? "";
      } catch {
        // 本文が JSON でない場合は無視する
      }
      if (status === 429) {
        return { ok: false, message: detail || "送信回数の上限に達しました。時間をおいてください。" };
      }
      if (status === 401) return { ok: false, message: "ログインし直してください。" };
      return { ok: false, message: detail || `送信に失敗しました（${status}）。` };
    }
    return { ok: false, message: "送信の依頼に失敗しました。通信状態を確認してください。" };
  }
  const body = data as { message?: string } | null;
  return { ok: true, message: body?.message ?? "送信しました。" };
}
