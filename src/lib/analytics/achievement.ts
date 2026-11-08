// 達成率（要件 F-502〜505）。
// 達成率＝完了÷（完了＋見送り＋未実施）。延期は最終結果で数える（延期→完了は完了）。
// 未確定（予定どおり・通知済み・延期中）は分母に入れず「未確定」として別に数える。完了とも失敗とも扱わない。
// 取り消し（アーカイブ・編集で無効になった予定）は数えない。
import { TIME_BANDS, type TimeBand } from "@/lib/time/bands";
import { addDays, isoWeekday } from "@/lib/time/jst";
import { diffPoints, rate, type Rate } from "./stats";
import type { FactRow } from "./types";

export type Outcome = { done: number; skipped: number; missed: number; open: number; cancelled: number };

export function countOutcomes(rows: readonly FactRow[]): Outcome {
  const o: Outcome = { done: 0, skipped: 0, missed: 0, open: 0, cancelled: 0 };
  for (const r of rows) {
    if (r.status === "done") o.done += 1;
    else if (r.status === "skipped") o.skipped += 1;
    else if (r.status === "missed") o.missed += 1;
    else if (r.status === "cancelled") o.cancelled += 1;
    else o.open += 1; // scheduled / notified / postponed
  }
  return o;
}

export function achievementOf(o: Outcome): Rate {
  return rate(o.done, o.done + o.skipped + o.missed);
}

export function achievement(rows: readonly FactRow[]): Rate {
  return achievementOf(countOutcomes(rows));
}

export type Bucket<K> = { key: K; outcome: Outcome; rate: Rate };

function bucketsBy<K>(rows: readonly FactRow[], keys: readonly K[], keyOf: (r: FactRow) => K): Bucket<K>[] {
  return keys.map((key) => {
    const outcome = countOutcomes(rows.filter((r) => keyOf(r) === key));
    return { key, outcome, rate: achievementOf(outcome) };
  });
}

/** 期間の日付（from〜to、両端を含む） */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** その日を含む週の月曜日（JST の日付） */
export function weekStart(date: string): string {
  return addDays(date, -(isoWeekday(date) - 1));
}

/** 日別（予定のない日も「データなし」として並べる） */
export function byDay(rows: readonly FactRow[], from: string, to: string): Bucket<string>[] {
  return bucketsBy(rows, datesBetween(from, to), (r) => r.planned_date);
}

/** 週別（月曜始まり）。期間の端の週は、期間内の日だけを数える */
export function byWeek(rows: readonly FactRow[], from: string, to: string): Bucket<string>[] {
  const weeks: string[] = [];
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) weeks.push(w);
  return bucketsBy(rows, weeks, (r) => weekStart(r.planned_date));
}

/** 曜日別・時間帯別：その区分の達成率と、それ以外の区分（まとめて）との差 */
export type Segment<K> = Bucket<K> & { others: Rate; diff: number | null };

function segments<K>(rows: readonly FactRow[], keys: readonly K[], keyOf: (r: FactRow) => K): Segment<K>[] {
  return bucketsBy(rows, keys, keyOf).map((b) => {
    const others = achievement(rows.filter((r) => keyOf(r) !== b.key));
    return { ...b, others, diff: diffPoints(b.rate, others) };
  });
}

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export function byWeekday(rows: readonly FactRow[]): Segment<number>[] {
  return segments(rows, WEEKDAYS, (r) => r.planned_weekday);
}

export function byTimeBand(rows: readonly FactRow[]): Segment<TimeBand>[] {
  return segments(rows, TIME_BANDS, (r) => r.time_band);
}
