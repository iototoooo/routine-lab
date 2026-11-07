"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { OccurrenceStatus } from "@/lib/domain/status";
import { STATUS_LABEL } from "@/lib/domain/status";

// 共通の見た目。タップ領域は 44px 以上（min-h-11）にする（NF-01）。

export const btnPrimary =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-4 font-bold text-accent-foreground disabled:opacity-60";
export const btnSecondary =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-surface px-4 disabled:opacity-60";
export const btnDanger =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-danger px-4 font-bold text-danger disabled:opacity-60";
export const inputBase = "mt-1 block min-h-11 w-full rounded-md border border-border bg-surface px-3";
export const card = "rounded-lg border border-border bg-surface p-4";

const STATUS_STYLE: Record<OccurrenceStatus, string> = {
  scheduled: "border-border text-muted",
  notified: "border-accent text-accent",
  postponed: "border-accent text-accent",
  done: "border-accent bg-accent text-accent-foreground",
  skipped: "border-border text-foreground",
  missed: "border-danger text-danger",
  cancelled: "border-border text-muted line-through",
};

export function StatusBadge({ status }: { status: OccurrenceStatus }) {
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-bold ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-md border border-danger p-3 text-sm text-danger" role="alert">
      {message}
    </p>
  );
}

export function Loading() {
  return <p className="text-muted">読み込み中…</p>;
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 今の時刻（30秒ごとに更新）。表示の「過ぎた・まだ」の判定に使う */
export function useNow(intervalMs = 30000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
