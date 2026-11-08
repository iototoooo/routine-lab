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

/** 予定の通知に使う情報（DB 関数 job_payloads の1行） */
export type OccurrenceInfo = {
  occurrence_id: string;
  kind: "initial" | "snooze";
  routine_name: string;
  planned_start_at: string;
  planned_duration_min: number;
  postpone_count: number;
};

const jstParts = (d: Date) => {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { ymd: `${get("year")}-${get("month")}-${get("day")}`, md: `${get("month")}/${get("day")}`, hm: `${Number(get("hour"))}:${get("minute")}`, wd: get("weekday") };
};
const WEEKDAY_JA: Record<string, string> = { Mon: "月", Tue: "火", Wed: "水", Thu: "木", Fri: "金", Sat: "土", Sun: "日" };

/**
 * 予定の通知の文面（F-301・F-304、判断事項5）。
 *   予定時刻：タイトル「ルーティン名」、本文「7:00〜 15分」
 *   再通知　：タイトル「ルーティン名（再通知）」、本文「予定 7:00〜 15分・延期1回目」
 * 送る日と予定日が違う（明日の同じ時刻への延期・0:00 をまたぐ再通知）ときは、予定日も入れる。
 * tag は予定 ID（端末の上で同じ予定の通知を置き換える。F-305）。
 */
export function occurrencePayload(info: OccurrenceInfo, sentAt: Date): NotificationPayload {
  const planned = jstParts(new Date(info.planned_start_at));
  const today = jstParts(sentAt);
  const when = planned.ymd === today.ymd ? planned.hm : `${planned.md}（${WEEKDAY_JA[planned.wd] ?? ""}）${planned.hm}`;
  const span = `${when}〜 ${info.planned_duration_min}分`;
  const isSnooze = info.kind === "snooze";
  return {
    title: isSnooze ? `${info.routine_name}（再通知）` : info.routine_name,
    body: isSnooze ? `予定 ${span}・延期${info.postpone_count}回目` : span,
    tag: info.occurrence_id,
    url: `/record/?o=${encodeURIComponent(info.occurrence_id)}`,
  };
}
