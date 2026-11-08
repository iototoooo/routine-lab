// 画面から DB への読み書き（supabase-js）。読み取りは RLS で本人の行だけ、書き込みは RPC だけ。
// 画面は SQL の形を知らず、ここの関数だけを呼ぶ。

import { getSupabase } from "@/lib/supabase/client";
import { unwrap } from "@/lib/data/errors";
import type {
  Execution,
  Occurrence,
  OccurrenceEvent,
  OccurrenceView,
  Routine,
  RoutineVersion,
} from "@/lib/data/types";
import type { RoutineSettings } from "@/lib/domain/routine";
import type { PostponeOption } from "@/lib/domain/postpone";
import type { ReasonCode } from "@/lib/domain/reasons";
import type { StartSource } from "@/lib/domain/record";
import type { NotificationJobView } from "@/lib/domain/notify";
import type { FactRow, ReasonEventRow, RoutineInfo, VersionInfo } from "@/lib/analytics/types";

const OCC_COLS =
  "id, routine_id, routine_version_id, planned_date, planned_start_at, planned_duration_min, status, next_remind_at, postpone_count, closed_at";
const EXEC_COLS =
  "id, occurrence_id, planned_date, actual_start_at, actual_end_at, actual_duration_min, executed_date, is_late_day, start_source, recorded_at, superseded_by";
const VERSION_COLS =
  "id, routine_id, version_no, name, note, weekdays, start_time, duration_min, snooze_min, valid_from, valid_to, change_reason, source, created_at";

const JOB_COLS = "occurrence_id, kind, fire_at, status, sent_at";
const ROUTINE_COLS = "id, name, note, archived_at, created_at, exclude_from_analytics";
const FACT_COLS =
  "occurrence_id, routine_id, routine_version_id, version_no, planned_date, planned_weekday, planned_start_at, time_band, planned_duration_min, status, is_final, postpone_count, actual_start_at, actual_duration_min, executed_date, is_late_day, start_source, delay_min, closing_reason_code";
const REASON_COLS = "event_id, occurrence_id, routine_id, planned_date, type, reason_code, postpone_option";
/** 1回に読む行数（PostgREST の既定の上限 1000 行に合わせて分けて読む） */
export const PAGE_SIZE = 1000;

const db = () => getSupabase();

/** 今日と明日の予定を作り、期限を過ぎた予定を未実施にする（アプリを開いたとき。F-201・F-406） */
export async function ensureOccurrences(): Promise<void> {
  unwrap(await db().rpc("ensure_occurrences"));
}

async function withNamesAndExecutions(occ: Occurrence[]): Promise<OccurrenceView[]> {
  if (occ.length === 0) return [];
  const routineIds = [...new Set(occ.map((o) => o.routine_id))];
  const occIds = occ.map((o) => o.id);
  const [routines, executions, jobs] = await Promise.all([
    db().from("routines").select("id, name").in("id", routineIds),
    db().from("executions").select(EXEC_COLS).in("occurrence_id", occIds).is("superseded_by", null),
    db().from("notification_jobs").select(JOB_COLS).in("occurrence_id", occIds),
  ]);
  const names = new Map(unwrap<{ id: string; name: string }[]>(routines).map((r) => [r.id, r.name]));
  const execs = new Map(unwrap<Execution[]>(executions).map((e) => [e.occurrence_id, e]));
  const jobsByOcc = new Map<string, NotificationJobView[]>();
  for (const j of unwrap<NotificationJobView[]>(jobs)) jobsByOcc.set(j.occurrence_id, [...(jobsByOcc.get(j.occurrence_id) ?? []), j]);
  return occ.map((o) => ({
    ...o,
    routine_name: names.get(o.routine_id) ?? "（不明）",
    execution: execs.get(o.id) ?? null,
    jobs: jobsByOcc.get(o.id) ?? [],
  }));
}

/** 指定した日付（JST）の予定（時刻順） */
export async function listOccurrences(dates: string[]): Promise<OccurrenceView[]> {
  const occ = unwrap<Occurrence[]>(
    await db().from("occurrences").select(OCC_COLS).in("planned_date", dates).order("planned_start_at"),
  );
  return withNamesAndExecutions(occ);
}

export type OccurrenceDetail = {
  occurrence: OccurrenceView;
  version: RoutineVersion | null;
  events: OccurrenceEvent[];
};

export async function getOccurrence(id: string): Promise<OccurrenceDetail | null> {
  const occ = unwrap<Occurrence[]>(await db().from("occurrences").select(OCC_COLS).eq("id", id));
  if (occ.length === 0) return null;
  const [view] = await withNamesAndExecutions(occ);
  const [version, events] = await Promise.all([
    db().from("routine_versions").select(VERSION_COLS).eq("id", occ[0]!.routine_version_id),
    db()
      .from("occurrence_events")
      .select("id, occurrence_id, type, from_status, to_status, remind_at, postpone_option, reason_code, reason_text, actor, detail, created_at")
      .eq("occurrence_id", id)
      .order("id"),
  ]);
  return {
    occurrence: view!,
    version: unwrap<RoutineVersion[]>(version)[0] ?? null,
    events: unwrap<OccurrenceEvent[]>(events),
  };
}

export type RoutineWithVersions = Routine & { versions: RoutineVersion[] };

export async function listRoutines(): Promise<RoutineWithVersions[]> {
  const [routines, versions] = await Promise.all([
    db().from("routines").select(ROUTINE_COLS).order("created_at"),
    db().from("routine_versions").select(VERSION_COLS).order("version_no"),
  ]);
  const vs = unwrap<RoutineVersion[]>(versions);
  return unwrap<Routine[]>(routines).map((r) => ({ ...r, versions: vs.filter((v) => v.routine_id === r.id) }));
}

export async function getRoutine(id: string): Promise<RoutineWithVersions | null> {
  const [routines, versions] = await Promise.all([
    db().from("routines").select(ROUTINE_COLS).eq("id", id),
    db().from("routine_versions").select(VERSION_COLS).eq("routine_id", id).order("version_no"),
  ]);
  const r = unwrap<Routine[]>(routines)[0];
  return r ? { ...r, versions: unwrap<RoutineVersion[]>(versions) } : null;
}

/** ルーティンの予定（新しい順、日付の範囲） */
export async function listRoutineOccurrences(routineId: string, fromDate: string): Promise<OccurrenceView[]> {
  const occ = unwrap<Occurrence[]>(
    await db()
      .from("occurrences")
      .select(OCC_COLS)
      .eq("routine_id", routineId)
      .gte("planned_date", fromDate)
      .order("planned_date", { ascending: false }),
  );
  return withNamesAndExecutions(occ);
}

const settingsArgs = (s: RoutineSettings) => ({
  p_name: s.name.trim(),
  p_note: s.note.trim() || null,
  p_weekdays: s.weekdays,
  p_start_time: s.startTime,
  p_duration_min: s.durationMin,
  p_snooze_min: s.snoozeMin,
});

export async function createRoutine(s: RoutineSettings): Promise<string> {
  return unwrap<string>(await db().rpc("create_routine", settingsArgs(s)));
}

export async function editRoutine(id: string, s: RoutineSettings, validFrom: string, reason: string): Promise<string> {
  return unwrap<string>(
    await db().rpc("edit_routine", {
      p_routine_id: id,
      ...settingsArgs(s),
      p_valid_from: validFrom,
      p_change_reason: reason.trim() || null,
    }),
  );
}

export async function archiveRoutine(id: string): Promise<void> {
  unwrap(await db().rpc("archive_routine", { p_routine_id: id }));
}

export async function recordDone(occurrenceId: string, actualStartAt: Date, durationMin: number, source: StartSource): Promise<void> {
  unwrap(
    await db().rpc("record_done", {
      p_occurrence_id: occurrenceId,
      p_actual_start_at: actualStartAt.toISOString(),
      p_actual_duration_min: durationMin,
      p_start_source: source,
    }),
  );
}

export async function postpone(
  occurrenceId: string,
  option: PostponeOption,
  remindAt: Date | null,
  reasonCode: ReasonCode | null,
  reasonText: string,
): Promise<void> {
  unwrap(
    await db().rpc("postpone", {
      p_occurrence_id: occurrenceId,
      p_option: option,
      p_remind_at: option === "today_at" && remindAt ? remindAt.toISOString() : null,
      p_reason_code: reasonCode,
      p_reason_text: reasonCode ? reasonText.trim() || null : null,
    }),
  );
}

export async function skipOccurrence(occurrenceId: string, reasonCode: ReasonCode, reasonText: string): Promise<void> {
  unwrap(
    await db().rpc("skip_occurrence", {
      p_occurrence_id: occurrenceId,
      p_reason_code: reasonCode,
      p_reason_text: reasonText.trim() || null,
    }),
  );
}

// ---------------------------------------------------------------------
// Phase 3：分析（docs/phase3-plan.md 5章）。集計はブラウザで行う（src/lib/analytics/）
// ---------------------------------------------------------------------

/** 1000 行ずつ、全部を読む（並びを固定して、重複・抜けがないようにする） */
async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const rows = unwrap<T[]>(await page(from, from + PAGE_SIZE - 1));
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

export type AnalyticsData = {
  facts: FactRow[];
  events: ReasonEventRow[];
  routines: RoutineInfo[];
  versions: VersionInfo[];
};

/**
 * 分析に使う本人の記録をすべて読む（RLS で本人の行だけ）。予定日が until 以前のものだけ
 * （明日の予定は分析に入れない）。1人分なら1年で数千行ほど。
 */
export async function loadAnalyticsData(until: string): Promise<AnalyticsData> {
  const [facts, events, routines, versions] = await Promise.all([
    readAll<FactRow>((a, b) =>
      db().from("occurrence_facts").select(FACT_COLS).lte("planned_date", until).order("planned_date").order("occurrence_id").range(a, b),
    ),
    readAll<ReasonEventRow>((a, b) =>
      db().from("occurrence_reason_facts").select(REASON_COLS).lte("planned_date", until).order("event_id").range(a, b),
    ),
    db().from("routines").select("id, name, archived_at, exclude_from_analytics").order("created_at"),
    db()
      .from("routine_versions")
      .select("id, routine_id, version_no, start_time, duration_min, weekdays, valid_from, valid_to, source")
      .order("version_no"),
  ]);
  return {
    facts: facts.map((f) => ({ ...f, delay_min: f.delay_min === null ? null : Number(f.delay_min) })),
    events,
    routines: unwrap<RoutineInfo[]>(routines),
    versions: unwrap<VersionInfo[]>(versions),
  };
}

/** 1つのルーティンの予定（分析用の行、版ごとの集計に使う） */
export async function loadRoutineFacts(routineId: string, until: string): Promise<FactRow[]> {
  const facts = await readAll<FactRow>((a, b) =>
    db()
      .from("occurrence_facts")
      .select(FACT_COLS)
      .eq("routine_id", routineId)
      .lte("planned_date", until)
      .order("planned_date")
      .order("occurrence_id")
      .range(a, b),
  );
  return facts.map((f) => ({ ...f, delay_min: f.delay_min === null ? null : Number(f.delay_min) }));
}

/** テスト用ルーティンを分析から外す・戻す（予定・実績・通知は変わらない） */
export async function setRoutineAnalytics(id: string, exclude: boolean): Promise<void> {
  unwrap(await db().rpc("set_routine_analytics", { p_routine_id: id, p_exclude: exclude }));
}
