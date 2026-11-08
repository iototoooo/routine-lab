// 分析画面の全体（docs/phase3-plan.md 4章）。期間・ルーティン・テスト用の扱いで行を絞り、各指標をまとめて計算する。
// 画面はこの結果を表示するだけ。Phase 4 の改善提案も、同じ関数（achievement / timing / reasons / continuity / versions）を使う。
import { addDays } from "@/lib/time/jst";
import { achievementOf, byDay, byTimeBand, byWeek, byWeekday, countOutcomes, type Bucket, type Outcome, type Segment } from "./achievement";
import { routineSummaries, type RoutineSummary } from "./continuity";
import { failureStats, postponeStats, type FailureStats, type PostponeStats } from "./reasons";
import type { Rate } from "./stats";
import { delayStats, durationStats, type DelayStats, type DurationStats } from "./timing";
import type { FactRow, ReasonEventRow, RecordFilter, RoutineInfo } from "./types";
import type { TimeBand } from "@/lib/time/bands";

export const PERIOD_KEYS = ["7d", "4w", "12w", "custom"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];
export const PERIOD_LABEL: Record<PeriodKey, string> = { "7d": "直近7日", "4w": "4週", "12w": "12週", custom: "期間を指定" };
const PERIOD_DAYS: Record<Exclude<PeriodKey, "custom">, number> = { "7d": 7, "4w": 28, "12w": 84 };
/** 期間の指定で選べる最大の日数（1年） */
export const MAX_CUSTOM_DAYS = 366;

export type Range = { from: string; to: string };

/** 期間（予定日、JST、両端を含む）。custom が正しくなければ null */
export function periodRange(key: PeriodKey, today: string, custom?: Partial<Range>): Range | null {
  if (key !== "custom") return { from: addDays(today, -(PERIOD_DAYS[key] - 1)), to: today };
  const { from, to } = custom ?? {};
  const ok = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!ok(from) || !ok(to) || from > to) return null;
  if (addDays(from, MAX_CUSTOM_DAYS - 1) < to) return null;
  return { from, to };
}

export type AnalyticsOptions = {
  range: Range;
  /** null＝すべてのルーティン */
  routineId: string | null;
  /** 「分析に含めない」のルーティンも入れるか */
  includeExcluded: boolean;
  filter: RecordFilter;
};

export type AnalyticsInput = {
  facts: readonly FactRow[];
  events: readonly ReasonEventRow[];
  routines: readonly RoutineInfo[];
  today: string;
};

export type AnalyticsReport = {
  range: Range;
  /** 集計の対象にしたルーティン */
  routines: RoutineInfo[];
  /** テスト用として外したルーティンの数 */
  excludedCount: number;
  outcome: Outcome;
  rate: Rate;
  /** 期間の終わりが「未実施の確定」前（予定日の翌日の終わりまで）にかかっているか */
  includesRecent: boolean;
  daily: Bucket<string>[];
  weekly: Bucket<string>[];
  weekday: Segment<number>[];
  timeBand: Segment<TimeBand>[];
  delay: DelayStats;
  duration: DurationStats;
  postpone: PostponeStats;
  failures: FailureStats;
  perRoutine: RoutineSummary[];
};

/** 集計の対象にするルーティン */
export function targetRoutines(routines: readonly RoutineInfo[], opts: Pick<AnalyticsOptions, "routineId" | "includeExcluded">): RoutineInfo[] {
  if (opts.routineId) return routines.filter((r) => r.id === opts.routineId);
  return routines.filter((r) => opts.includeExcluded || !r.exclude_from_analytics);
}

export function analyze(input: AnalyticsInput, opts: AnalyticsOptions): AnalyticsReport {
  const routines = targetRoutines(input.routines, opts);
  const ids = new Set(routines.map((r) => r.id));
  const all = input.facts.filter((r) => ids.has(r.routine_id));
  const rows = all.filter((r) => r.planned_date >= opts.range.from && r.planned_date <= opts.range.to);
  const outcome = countOutcomes(rows);
  return {
    range: opts.range,
    routines,
    excludedCount: opts.routineId || opts.includeExcluded ? 0 : input.routines.filter((r) => r.exclude_from_analytics).length,
    outcome,
    rate: achievementOf(outcome),
    includesRecent: opts.range.to >= addDays(input.today, -1),
    daily: byDay(rows, opts.range.from, opts.range.to),
    weekly: byWeek(rows, opts.range.from, opts.range.to),
    weekday: byWeekday(rows),
    timeBand: byTimeBand(rows),
    delay: delayStats(rows, opts.filter),
    duration: durationStats(rows, opts.filter),
    postpone: postponeStats(rows, input.events),
    failures: failureStats(rows),
    perRoutine: routineSummaries(routines, rows, all, input.today, opts.filter),
  };
}
