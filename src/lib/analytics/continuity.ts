// ルーティンごとの継続と変化。
// 連続達成（判断事項5）：確定した予定（完了・見送り・未実施）を予定日の順に並べ、完了が続いた回数を数える。
//   - 予定のない日（曜日の設定で予定が作られない日）はそもそも行がないので、途切れない
//   - 見送り・未実施で途切れる
//   - 未確定（予定どおり・通知済み・延期中）と取り消しは飛ばす（途切れも続きもしない）
import { addDays } from "@/lib/time/jst";
import { achievement } from "./achievement";
import { diffPoints, rate, type Rate, type Sample } from "./stats";
import { delayStats, durationStats } from "./timing";
import type { FactRow, RecordFilter, RoutineInfo } from "./types";

export type Streaks = { current: number; longest: number; finals: number };

export function streaks(rows: readonly FactRow[]): Streaks {
  const final = rows
    .filter((r) => r.is_final)
    .sort((a, b) => (a.planned_date === b.planned_date ? a.planned_start_at.localeCompare(b.planned_start_at) : a.planned_date.localeCompare(b.planned_date)));
  let run = 0;
  let longest = 0;
  for (const r of final) {
    run = r.status === "done" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return { current: run, longest, finals: final.length };
}

export type WindowRate = { from: string; to: string; rate: Rate };
export type RecentTrend = { recent: WindowRate; previous: WindowRate; diff: number | null };

/** 直近 N 週（today を含む N×7 日）と、その前の N 週の達成率 */
export function recentTrend(rows: readonly FactRow[], today: string, weeks = 4): RecentTrend {
  const days = weeks * 7;
  const win = (from: string, to: string): WindowRate => ({
    from,
    to,
    rate: achievement(rows.filter((r) => r.planned_date >= from && r.planned_date <= to)),
  });
  const recent = win(addDays(today, -(days - 1)), today);
  const previous = win(addDays(today, -(2 * days - 1)), addDays(today, -days));
  return { recent, previous, diff: diffPoints(recent.rate, previous.rate) };
}

export type RoutineSummary = {
  routine: RoutineInfo;
  /** 選んだ期間の達成率 */
  rate: Rate;
  delayMedian: Sample;
  durationRatio: Sample;
  postponed: Rate;
  /** 連続達成（記録全体で数える） */
  streaks: Streaks;
  trend: RecentTrend;
};

/**
 * ルーティンごとの一覧。periodRows＝選んだ期間の行、allRows＝そのルーティンの全期間の行（連続達成・直近4週の比較用）
 */
export function routineSummaries(
  routines: readonly RoutineInfo[],
  periodRows: readonly FactRow[],
  allRows: readonly FactRow[],
  today: string,
  filter: RecordFilter = "all",
): RoutineSummary[] {
  return routines.map((routine) => {
    const p = periodRows.filter((r) => r.routine_id === routine.id);
    const a = allRows.filter((r) => r.routine_id === routine.id);
    const final = p.filter((r) => r.is_final);
    return {
      routine,
      rate: achievement(p),
      delayMedian: delayStats(p, filter).median,
      durationRatio: durationStats(p, filter).ratio,
      postponed: rate(final.filter((r) => r.postpone_count > 0).length, final.length),
      streaks: streaks(a),
      trend: recentTrend(a, today),
    };
  });
}
