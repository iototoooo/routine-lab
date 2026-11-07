// 予定の状態（要件 6.1 節 occurrences.status）と、状態ごとにできる操作。
// DB 側の規則（supabase/migrations/20261107000200_phase1_rpc.sql の _lock_open_occurrence）と同じ。

import { occurrenceDeadline } from "@/lib/time/jst";

export const OCCURRENCE_STATUSES = [
  "scheduled",
  "notified",
  "postponed",
  "done",
  "skipped",
  "missed",
  "cancelled",
] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const STATUS_LABEL: Record<OccurrenceStatus, string> = {
  scheduled: "予定",
  notified: "通知済み",
  postponed: "延期中",
  done: "完了",
  skipped: "見送り",
  missed: "未実施",
  cancelled: "取り消し",
};

/** まだ確定していない（完了・延期・見送りを記録できる）状態 */
export function isOpen(status: OccurrenceStatus): boolean {
  return status === "scheduled" || status === "notified" || status === "postponed";
}

/** 記録できるか：未確定かつ期限（予定日の翌日の終わり）前 */
export function canRecord(o: { status: OccurrenceStatus; planned_date: string }, now: Date): boolean {
  return isOpen(o.status) && now.getTime() < occurrenceDeadline(o.planned_date).getTime();
}
