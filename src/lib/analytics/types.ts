// 分析の入力（DB のビューの行）。docs/phase3-plan.md 2章。
// occurrence_facts：予定1回＝1行（supabase/migrations/20261107000000_phase1_schema.sql）
// occurrence_reason_facts：延期・見送り・未実施のイベント1件＝1行（20261109000000_phase3_analytics.sql）
import type { OccurrenceStatus } from "@/lib/domain/status";
import type { PostponeOption } from "@/lib/domain/postpone";
import type { ReasonCode } from "@/lib/domain/reasons";
import type { StartSource } from "@/lib/domain/record";
import type { TimeBand } from "@/lib/time/bands";

export type FactRow = {
  occurrence_id: string;
  routine_id: string;
  routine_version_id: string;
  version_no: number;
  planned_date: string; // JST の日付
  planned_weekday: number; // 1=月 … 7=日
  planned_start_at: string;
  time_band: TimeBand;
  planned_duration_min: number;
  status: OccurrenceStatus;
  is_final: boolean;
  postpone_count: number;
  actual_start_at: string | null;
  actual_duration_min: number | null;
  executed_date: string | null;
  is_late_day: boolean | null;
  start_source: StartSource | null;
  delay_min: number | null;
  closing_reason_code: ReasonCode | null;
};

export type ReasonEventRow = {
  event_id: number;
  occurrence_id: string;
  routine_id: string;
  planned_date: string;
  type: "postponed" | "skipped" | "missed";
  reason_code: ReasonCode | null;
  postpone_option: PostponeOption | null;
};

/** 分析で使うルーティンの情報 */
export type RoutineInfo = {
  id: string;
  name: string;
  archived_at: string | null;
  exclude_from_analytics: boolean;
};

/** 分析で使う版の情報（有効期間は [valid_from, valid_to)） */
export type VersionInfo = {
  id: string;
  routine_id: string;
  version_no: number;
  start_time: string;
  duration_min: number;
  weekdays: number[];
  valid_from: string;
  valid_to: string | null;
  source: "manual" | "suggestion";
};

/** 遅延・所要時間の集計に入れる記録：all＝すべて、measured＝実測・時刻指定だけ（「予定どおり」で記録したものを除く） */
export type RecordFilter = "all" | "measured";
