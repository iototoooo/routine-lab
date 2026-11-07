// DB の行の型（supabase/migrations/20261107000000_phase1_schema.sql と同じ列）
import type { OccurrenceStatus } from "@/lib/domain/status";
import type { ReasonCode } from "@/lib/domain/reasons";
import type { PostponeOption } from "@/lib/domain/postpone";
import type { StartSource } from "@/lib/domain/record";

export type Routine = {
  id: string;
  name: string;
  note: string | null;
  archived_at: string | null;
  created_at: string;
};

export type RoutineVersion = {
  id: string;
  routine_id: string;
  version_no: number;
  name: string;
  note: string | null;
  weekdays: number[];
  start_time: string; // "HH:MM:SS"
  duration_min: number;
  snooze_min: number;
  valid_from: string;
  valid_to: string | null;
  change_reason: string | null;
  source: "manual" | "suggestion";
  created_at: string;
};

export type Occurrence = {
  id: string;
  routine_id: string;
  routine_version_id: string;
  planned_date: string;
  planned_start_at: string;
  planned_duration_min: number;
  status: OccurrenceStatus;
  next_remind_at: string | null;
  postpone_count: number;
  closed_at: string | null;
};

export type Execution = {
  id: string;
  occurrence_id: string;
  planned_date: string;
  actual_start_at: string;
  actual_end_at: string;
  actual_duration_min: number;
  executed_date: string;
  is_late_day: boolean;
  start_source: StartSource;
  recorded_at: string;
  superseded_by: string | null;
};

export type OccurrenceEvent = {
  id: number;
  occurrence_id: string;
  type: "done" | "postponed" | "skipped" | "missed" | "edited" | "cancelled" | "notified";
  from_status: OccurrenceStatus | null;
  to_status: OccurrenceStatus | null;
  remind_at: string | null;
  postpone_option: PostponeOption | null;
  reason_code: ReasonCode | null;
  reason_text: string | null;
  actor: "user" | "system";
  detail: Record<string, unknown> | null;
  created_at: string;
};

/** 画面で使う：予定＋ルーティン名＋今の実績 */
export type OccurrenceView = Occurrence & {
  routine_name: string;
  execution: Execution | null;
};
