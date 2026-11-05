// 通知の文面。リクエストからは受け取らず、サーバー側で組み立てる（docs/plan.md 4.1 節）。

export type NotificationPayload = {
  title: string;
  body: string;
  tag: string; // 端末上で置き換えるためのキー（予定ID。F-305）
  url: string; // タップで開くパス（同じサイト内のみ。sw.js でも検証する）
};

/** テスト通知（固定文面）。tag をジョブ単位にして、テストでも置き換えの動作を確認できるようにする */
export function testPayload(tag: string, sentAt: Date): NotificationPayload {
  const hhmm = sentAt.toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
  return {
    title: "Routine Lab テスト通知",
    body: `${hhmm} に送信しました。タップすると記録画面が開きます。`,
    tag: `test-${tag}`,
    url: `/record/?o=test-${encodeURIComponent(tag)}`,
  };
}
