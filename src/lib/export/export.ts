// データの書き出し（要件 F-801、docs/phase4-plan.md 5章）。ファイルは画面（ブラウザ）の中で作り、サーバーには送らない。
// 含めるのはログイン本人の記録だけ（RLS で本人の行しか読めない）。
// 含めないもの：ログイン情報（トークン）、通知先の端末の情報（endpoint・鍵）、送信結果の詳細、テスト通知の記録、秘密の値。
import type { FactRow } from "@/lib/analytics/types";
import { jstDate, jstTime } from "@/lib/time/jst";

export const EXPORT_FORMAT_VERSION = 1;

/** JSON に入れる表（この順で書き出す） */
export const EXPORT_TABLES = [
  "profiles",
  "routines",
  "routine_versions",
  "occurrences",
  "executions",
  "occurrence_events",
  "suggestions",
  "notification_jobs",
] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];
export type ExportData = Record<ExportTable, Record<string, unknown>[]>;

export function buildJson(data: ExportData, exportedAt: Date): string {
  const out = {
    app: "Routine Lab",
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: exportedAt.toISOString(),
    timezone: "Asia/Tokyo（日付は JST、時刻は UTC の ISO 形式）",
    excluded: "ログイン情報・通知先の端末の情報（endpoint・鍵）・通知の送信結果の詳細・テスト通知の記録は含めません",
    tables: Object.fromEntries(EXPORT_TABLES.map((t) => [t, data[t] ?? []])),
  };
  return JSON.stringify(out, null, 2);
}

/** CSV の1つの値（, " 改行を含むときは引用符で囲み、" は "" にする） */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join(" ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  // 表計算ソフトで式として扱われないように、= + - @ で始まる文字列の前に ' を付ける（数値はそのまま）
  const safe = typeof v === "string" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** BOM 付き UTF-8 の CSV（Excel で文字化けしないように）。改行は CRLF */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: "予定", notified: "通知済み", postponed: "延期中", done: "完了", skipped: "見送り", missed: "未実施", cancelled: "取り消し",
};
const SOURCE_LABEL: Record<string, string> = { planned: "予定どおり", now: "今終わった", timer: "タイマー", manual: "時刻を指定" };

/** 予定と実績の CSV（予定1回＝1行）。日時は JST の表記と UTC の ISO 形式の両方 */
export function factsCsv(facts: readonly FactRow[], routineNames: ReadonlyMap<string, string>): string {
  const header = [
    "予定日", "曜日", "ルーティン", "版", "予定の開始（JST）", "予定の所要時間（分）", "状態", "延期の回数",
    "実際の開始（JST）", "実際の所要時間（分）", "実施日", "翌日以降に実施", "記録のしかた", "遅れ（分）", "見送り・未実施の理由",
    "予定の開始（UTC）", "実際の開始（UTC）", "予定ID", "ルーティンID", "版ID",
  ];
  const sorted = [...facts].sort((a, b) => a.planned_start_at.localeCompare(b.planned_start_at) || a.occurrence_id.localeCompare(b.occurrence_id));
  const rows = sorted.map((f) => {
    const planned = new Date(f.planned_start_at);
    const actual = f.actual_start_at ? new Date(f.actual_start_at) : null;
    return [
      f.planned_date, "月火水木金土日"[f.planned_weekday - 1], routineNames.get(f.routine_id) ?? "", f.version_no,
      `${jstDate(planned)} ${jstTime(planned)}`, f.planned_duration_min, STATUS_LABEL[f.status] ?? f.status, f.postpone_count,
      actual ? `${jstDate(actual)} ${jstTime(actual)}` : "", f.actual_duration_min, f.executed_date, f.is_late_day === null ? "" : f.is_late_day ? "はい" : "いいえ",
      f.start_source ? (SOURCE_LABEL[f.start_source] ?? f.start_source) : "", f.delay_min, f.closing_reason_code,
      f.planned_start_at, f.actual_start_at, f.occurrence_id, f.routine_id, f.routine_version_id,
    ];
  });
  return toCsv(header, rows);
}

/** ファイル名（例：routine-lab-20261110.json） */
export function exportFileName(now: Date, ext: "json" | "csv"): string {
  return `routine-lab-${jstDate(now).replace(/-/g, "")}.${ext}`;
}
