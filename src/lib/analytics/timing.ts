// 予定と実際の差（要件 F-506・F-507）。対象は完了して実績がある予定だけ。
//
// 記録画面の「予定どおり」で完了すると、実際の開始＝予定時刻（遅延0分）として保存される（start_source='planned'）。
// これは本人が入力した値で、計った値ではない。集計には含めるが、件数を分けて示し、
// 「実測・時刻指定だけ」（今・タイマー・手入力）に絞った集計もできるようにする（判断事項3）。
import { countBy, mean, median, rate, sample, type Rate, type Sample } from "./stats";
import type { FactRow, RecordFilter } from "./types";

export const ON_TIME_MIN = 10;

export const DELAY_BUCKETS = ["early", "onTime", "late30", "late60", "lateOver", "lateDay"] as const;
export type DelayBucket = (typeof DELAY_BUCKETS)[number];
export const DELAY_BUCKET_LABEL: Record<DelayBucket, string> = {
  early: "10分より早く",
  onTime: "±10分以内",
  late30: "10〜30分遅れ",
  late60: "30〜60分遅れ",
  lateOver: "60分を超える遅れ",
  lateDay: "翌日以降に実施",
};

/** 完了して実績がある予定（filter=measured なら「予定どおり」で記録したものを除く） */
export function executedRows(rows: readonly FactRow[], filter: RecordFilter = "all"): FactRow[] {
  return rows.filter(
    (r) => r.status === "done" && r.actual_start_at !== null && (filter === "all" || r.start_source !== "planned"),
  );
}

/** 遅延（分）：実際の開始 − 予定の開始。DB のビューの値を使う */
export function delayOf(r: FactRow): number {
  if (r.delay_min !== null) return r.delay_min;
  return Math.round((new Date(r.actual_start_at!).getTime() - new Date(r.planned_start_at).getTime()) / 60000);
}

export function delayBucket(r: FactRow): DelayBucket {
  if (r.is_late_day) return "lateDay";
  const d = delayOf(r);
  if (d < -ON_TIME_MIN) return "early";
  if (d <= ON_TIME_MIN) return "onTime";
  if (d <= 30) return "late30";
  if (d <= 60) return "late60";
  return "lateOver";
}

export type DelayStats = {
  median: Sample;
  mean: Sample;
  /** ±10分以内に始めた割合 */
  onTime: Rate;
  /** 予定日の翌日以降に実施した割合 */
  lateDay: Rate;
  buckets: Record<DelayBucket, number>;
  /** 記録のしかたの内訳：planned＝「予定どおり」（入力上の0分）、measured＝今・タイマー・手入力 */
  sources: { planned: number; measured: number };
  /** 実測で遅延が0分だったもの（「予定どおり」の入力とは別に数える） */
  measuredZero: number;
};

export function delayStats(rows: readonly FactRow[], filter: RecordFilter = "all"): DelayStats {
  const xs = executedRows(rows, filter);
  const delays = xs.map(delayOf);
  const planned = xs.filter((r) => r.start_source === "planned").length;
  return {
    median: sample(delays, median),
    mean: sample(delays, mean),
    onTime: rate(xs.filter((r) => !r.is_late_day && Math.abs(delayOf(r)) <= ON_TIME_MIN).length, xs.length),
    lateDay: rate(xs.filter((r) => r.is_late_day).length, xs.length),
    buckets: countBy(DELAY_BUCKETS, xs.map(delayBucket)),
    sources: { planned, measured: xs.length - planned },
    measuredZero: xs.filter((r) => r.start_source !== "planned" && delayOf(r) === 0).length,
  };
}

export type DurationStats = {
  /** 実際÷予定の中央値（1.3 なら予定の1.3倍） */
  ratio: Sample;
  /** 実際−予定（分）の中央値 */
  diff: Sample;
  /** 予定より長くかかった割合 */
  longer: Rate;
  /** 予定より短く終えた割合 */
  shorter: Rate;
};

export function durationStats(rows: readonly FactRow[], filter: RecordFilter = "all"): DurationStats {
  const xs = executedRows(rows, filter).filter((r) => r.actual_duration_min !== null);
  const ratios = xs.map((r) => r.actual_duration_min! / r.planned_duration_min);
  const diffs = xs.map((r) => r.actual_duration_min! - r.planned_duration_min);
  return {
    ratio: sample(ratios, median),
    diff: sample(diffs, median),
    longer: rate(diffs.filter((d) => d > 0).length, xs.length),
    shorter: rate(diffs.filter((d) => d < 0).length, xs.length),
  };
}
