// 予定の通知ジョブ（notification_jobs）を、画面に出す1行にまとめる（docs/phase2-plan.md 5章）。
// 「送信済み」は Push サービスが受け付けたという意味で、端末に表示されたことまでは分からない。

import { jstTime } from "@/lib/time/jst";

export const JOB_STATUSES = ["pending", "sending", "sent", "failed", "expired", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const CANCEL_REASONS = ["closed", "rescheduled", "postponed", "superseded", "stale"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export type NotificationJobView = {
  occurrence_id: string;
  kind: "initial" | "snooze" | "test";
  fire_at: string;
  status: JobStatus;
  sent_at: string | null;
};

export type NotificationSummary = { text: string; tone: "muted" | "warn" };

/**
 * これから送る通知があればそれを、なければ最後に送った（送ろうとした）通知を表す。
 * 取り消したジョブは出さない（予定の記録や延期し直しで不要になったもの）。
 */
export function notificationSummary(jobs: NotificationJobView[]): NotificationSummary | null {
  const label = (j: NotificationJobView) => (j.kind === "snooze" ? "再通知" : "通知");
  const time = (iso: string) => jstTime(new Date(iso));
  const upcoming = jobs
    .filter((j) => j.status === "pending" || j.status === "sending")
    .sort((a, b) => a.fire_at.localeCompare(b.fire_at))[0];
  if (upcoming) return { text: `${label(upcoming)} ${time(upcoming.fire_at)} に送信予定`, tone: "muted" };
  const last = jobs
    .filter((j) => j.status === "sent" || j.status === "failed" || j.status === "expired")
    .sort((a, b) => b.fire_at.localeCompare(a.fire_at))[0];
  if (!last) return null;
  if (last.status === "sent") return { text: `${label(last)} ${time(last.sent_at ?? last.fire_at)} に送信済み`, tone: "muted" };
  if (last.status === "expired") return { text: `${label(last)}（${time(last.fire_at)}）は送れないまま期限切れ`, tone: "warn" };
  return { text: `${label(last)}（${time(last.fire_at)}）を送れませんでした。設定で端末の登録を確認してください`, tone: "warn" };
}
