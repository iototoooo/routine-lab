// 版（設定）ごとの集計と、変更前後の比較の準備（Phase 4 の F-701・F-702 の土台）。
// 予定は作成時の版（routine_version_id）を持つので、版ごとの実績はその列で分けられる。
// 比較では、期間の長さをそろえ、件数と対象期間を必ず示す（件数が少なければ注意を出す）。
import { addDays } from "@/lib/time/jst";
import { achievement, datesBetween } from "./achievement";
import { REASON_CODES } from "@/lib/domain/reasons";
import { MIN_SAMPLE, countBy, rate, type Rate, type Sample } from "./stats";
import { delayStats, durationStats, executedRows } from "./timing";
import { REASON_KEYS, type ReasonKey } from "./reasons";
import type { FactRow, RecordFilter, VersionInfo } from "./types";

export type PeriodStats = {
  /** 対象の予定（取り消しを除く）の件数と、達成率の分母（確定した件数） */
  occurrences: number;
  rate: Rate;
  delayMedian: Sample;
  onTime: Rate;
  durationRatio: Sample;
  postponed: Rate;
  /** 予定日の翌日以降に実施した割合 */
  lateDay: Rate;
  /** 見送り・未実施の理由（最後に記録された理由。なしは none） */
  reasons: Record<ReasonKey, number>;
  /** 「予定どおり」で記録した完了の件数（遅れは入力上の0分） */
  plannedRecords: number;
};

export function periodStats(rows: readonly FactRow[], filter: RecordFilter = "all"): PeriodStats {
  const final = rows.filter((r) => r.is_final);
  const d = delayStats(rows, filter);
  return {
    occurrences: rows.filter((r) => r.status !== "cancelled").length,
    rate: achievement(rows),
    delayMedian: d.median,
    onTime: d.onTime,
    durationRatio: durationStats(rows, filter).ratio,
    postponed: rate(final.filter((r) => r.postpone_count > 0).length, final.length),
    lateDay: d.lateDay,
    reasons: countBy(
      REASON_KEYS,
      final
        .filter((r) => r.status !== "done")
        .map((r): ReasonKey => (r.closing_reason_code && (REASON_CODES as readonly string[]).includes(r.closing_reason_code) ? r.closing_reason_code : "none")),
    ),
    plannedRecords: executedRows(rows, "all").filter((r) => r.start_source === "planned").length,
  };
}

/** 一度も有効にならなかった版（同じ日に2回以上編集したとき） */
const neverEffective = (v: VersionInfo) => v.valid_to !== null && v.valid_to === v.valid_from;

export type VersionStats = {
  version: VersionInfo;
  /** 有効期間（to は含む最終日。今も有効なら null） */
  from: string;
  to: string | null;
  stats: PeriodStats;
};

/** 1つのルーティンの版ごとの集計（新しい版から順。一度も有効にならなかった版は除く） */
export function versionStats(rows: readonly FactRow[], versions: readonly VersionInfo[], filter: RecordFilter = "all"): VersionStats[] {
  return [...versions]
    .filter((v) => !neverEffective(v))
    .sort((a, b) => b.version_no - a.version_no)
    .map((version) => ({
      version,
      from: version.valid_from,
      to: version.valid_to === null ? null : addDays(version.valid_to, -1),
      stats: periodStats(rows.filter((r) => r.routine_version_id === version.id), filter),
    }));
}

export type ComparedWindow = { version: VersionInfo; from: string; to: string; stats: PeriodStats };
export type VersionComparison = {
  before: ComparedWindow;
  after: ComparedWindow;
  /** 比べる日数（両方で同じ） */
  days: number;
  warnings: string[];
};

/** 今の日付で比べられる版（一度も有効にならなかった版を除き、古い順） */
export function comparableVersions(versions: readonly VersionInfo[], today: string): VersionInfo[] {
  return [...versions].filter((v) => !neverEffective(v) && v.valid_from <= today).sort((a, b) => a.version_no - b.version_no);
}

/**
 * 2つの版を、同じ長さの期間で比べる（要件 F-701・F-702）。
 * before：古い版の有効期間の最後の N 日、after：新しい版の有効期間の最初の N 日（どちらも今日まで）。
 * N は weeks×7 日までで、両方にある日数の短いほうにそろえる。
 * 比べられない（同じ版・順番が逆・どちらかがまだ1日もない）ときは null（画面では「データ不足」）。
 */
export function compareVersions(
  rows: readonly FactRow[],
  versions: readonly VersionInfo[],
  beforeId: string,
  afterId: string,
  today: string,
  weeks = 4,
  filter: RecordFilter = "all",
): VersionComparison | null {
  const effective = [...versions].filter((v) => !neverEffective(v));
  const before = effective.find((v) => v.id === beforeId);
  const after = effective.find((v) => v.id === afterId);
  if (!before || !after || before.version_no >= after.version_no) return null;
  const lastDay = (v: VersionInfo) =>
    [today, v.valid_to === null ? null : addDays(v.valid_to, -1)].filter((x): x is string => x !== null).sort()[0]!;
  const afterEnd = lastDay(after);
  const beforeEnd = lastDay(before);
  const afterDays = afterEnd < after.valid_from ? 0 : datesBetween(after.valid_from, afterEnd).length;
  const beforeDays = beforeEnd < before.valid_from ? 0 : datesBetween(before.valid_from, beforeEnd).length;
  const days = Math.min(weeks * 7, afterDays, beforeDays);
  if (days <= 0) return null;

  const win = (v: VersionInfo, from: string, to: string): ComparedWindow => ({
    version: v,
    from,
    to,
    stats: periodStats(
      rows.filter((r) => r.routine_version_id === v.id && r.planned_date >= from && r.planned_date <= to),
      filter,
    ),
  });
  const a = win(after, after.valid_from, addDays(after.valid_from, days - 1));
  const b = win(before, addDays(beforeEnd, -(days - 1)), beforeEnd);
  const warnings: string[] = [];
  if (days < weeks * 7) warnings.push(`比べられる期間が ${days} 日だけです（目安は ${weeks * 7} 日）。`);
  for (const [label, w] of [["変更前", b], ["変更後", a]] as const) {
    if (w.stats.rate.den < MIN_SAMPLE) warnings.push(`${label}の確定した予定が ${w.stats.rate.den} 件だけです（5件未満は参考値）。`);
  }
  if (filter === "all" && a.stats.plannedRecords + b.stats.plannedRecords > 0) {
    warnings.push(`「予定どおり」で記録した完了（遅れは入力上の0分）を、変更前 ${b.stats.plannedRecords} 件・変更後 ${a.stats.plannedRecords} 件含みます。`);
  }
  return { before: b, after: a, days, warnings };
}

/**
 * ある版（after）と、その直前に有効だった版（before）を、同じ長さの期間で比べる（ルーティン詳細の簡単な比較）。
 * 比べられない（最初の版・直前の版がない・まだ1日も経っていない）ときは null。
 */
export function compareWithPrevious(
  rows: readonly FactRow[],
  versions: readonly VersionInfo[],
  versionId: string,
  today: string,
  weeks = 4,
  filter: RecordFilter = "all",
): VersionComparison | null {
  const effective = [...versions].filter((v) => !neverEffective(v)).sort((a, b) => a.version_no - b.version_no);
  const i = effective.findIndex((v) => v.id === versionId);
  if (i <= 0) return null;
  return compareVersions(rows, versions, effective[i - 1]!.id, effective[i]!.id, today, weeks, filter);
}
