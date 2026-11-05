"use client";

import { useEffect } from "react";

// Service Worker（public/sw.js）を登録する。
// 通知のタップ時に sw.js が既存の画面へ「移動して」と頼んできた場合（navigate が使えない環境）の受け口も兼ねる。
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // 登録に失敗しても、アプリ内の表示と記録は使える（F-310）
    });

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type !== "navigate" || typeof data.url !== "string") return;
      const target = new URL(data.url, window.location.origin);
      if (target.origin !== window.location.origin) return;
      window.location.assign(target.pathname + target.search);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  return null;
}
