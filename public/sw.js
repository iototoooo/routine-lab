/* Routine Lab Service Worker（docs/plan.md 4章）
 * - push を受け取ったら、必ず通知を表示する（iOS は表示しないと購読が取り消される）
 * - tag に予定IDを使い、同じ予定の通知は端末上で置き換える（F-305）
 * - 通知のタップで、記録画面（同じサイト内のパスだけ）を開く（F-401）
 * キャッシュは持たない（Phase 0 時点。オフライン対応は将来の検討事項）。
 */

const DEFAULT_TITLE = "Routine Lab";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** 同じサイト内のパスだけを許す。それ以外はトップへ */
function safePath(url) {
  try {
    const u = new URL(url || "/", self.location.origin);
    if (u.origin !== self.location.origin) return "/";
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }
  const title = typeof data.title === "string" && data.title ? data.title : DEFAULT_TITLE;
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" && data.tag ? data.tag : "routine-lab",
    renotify: true,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: { url: safePath(data.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  const target = new URL(path, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ("navigate" in client) {
          try {
            await client.navigate(target);
            return;
          } catch {
            // navigate が使えない場合は、画面側に移動を頼む
          }
        }
        client.postMessage({ type: "navigate", url: path });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
