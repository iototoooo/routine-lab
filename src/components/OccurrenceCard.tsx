"use client";

import Link from "next/link";
import type { OccurrenceView } from "@/lib/data/types";
import { canRecord } from "@/lib/domain/status";
import { formatDuration } from "@/lib/domain/routine";
import { jstTime, minutesBetween } from "@/lib/time/jst";
import { StatusBadge, btnPrimary, btnSecondary, card } from "@/components/ui";
import { notificationSummary } from "@/lib/domain/notify";

/** 予定時刻と実行時刻の差（例：+12分、予定どおり） */
export function delayLabel(plannedStartAt: string, actualStartAt: string): string {
  const d = minutesBetween(new Date(plannedStartAt), new Date(actualStartAt));
  if (d === 0) return "予定どおり";
  return d > 0 ? `${d}分遅れ` : `${-d}分早め`;
}

export function OccurrenceCard({
  o,
  now,
  busy,
  onQuickDone,
}: {
  o: OccurrenceView;
  now: Date;
  busy: boolean;
  onQuickDone?: (o: OccurrenceView) => void;
}) {
  const recordable = canRecord(o, now);
  const started = new Date(o.planned_start_at).getTime() <= now.getTime();
  const notice = notificationSummary(o.jobs ?? []);
  return (
    <li className={card}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted">
            <span className="text-base font-bold text-foreground">{jstTime(new Date(o.planned_start_at))}</span>
            {" ・ "}
            {formatDuration(o.planned_duration_min)}
          </p>
          <p className="mt-0.5 break-words font-bold">{o.routine_name}</p>
          {o.status === "postponed" && o.next_remind_at && (
            <p className="mt-1 text-sm text-muted">
              再通知 {jstTime(new Date(o.next_remind_at))}（延期 {o.postpone_count}回）
            </p>
          )}
          {notice && (
            <p className={`mt-1 text-sm ${notice.tone === "warn" ? "text-danger" : "text-muted"}`}>{notice.text}</p>
          )}
          {o.execution && (
            <p className="mt-1 text-sm text-muted">
              {jstTime(new Date(o.execution.actual_start_at))} 開始・{formatDuration(o.execution.actual_duration_min)}（
              {delayLabel(o.planned_start_at, o.execution.actual_start_at)}
              {o.execution.is_late_day ? "・翌日以降に実施" : ""}）
            </p>
          )}
        </div>
        <StatusBadge status={o.status} />
      </div>
      {recordable && (
        <div className="mt-3 flex gap-2">
          {onQuickDone && started && (
            <button type="button" className={`${btnPrimary} flex-1`} disabled={busy} onClick={() => onQuickDone(o)}>
              予定どおり完了
            </button>
          )}
          <Link href={`/record/?o=${o.id}`} className={`${btnSecondary} flex-1`}>
            記録する
          </Link>
        </div>
      )}
      {!recordable && (
        <Link href={`/record/?o=${o.id}`} className="mt-2 inline-flex min-h-11 items-center text-sm text-accent">
          詳しく見る
        </Link>
      )}
    </li>
  );
}
