// 改善提案のルール（要件 F-601〜603・6.2 節、docs/phase4-plan.md 2章）。UI から切り離した純粋関数。
// 入力は分析と同じ行（occurrence_facts）と、版・ルーティン・判断の記録。提案は画面を開くたびに計算する。
//
// 共通の決まり：
// - 対象：アーカイブしていない・テスト用でない（exclude_from_analytics = false）ルーティン
// - 期間：昨日までの直近 28 日。今の版（valid_to が null）の予定だけを使う（版を変えた直後は件数が足りず、提案は出ない）
// - 今の版で確定した予定が 5 件以上のときだけ判定する。足りなければ提案しない（無理に出さない）
// - 同じルーティン・同じルールは、判断（却下・承認）した日から 28 日間は出さない
import { executedRows, delayOf } from "@/lib/analytics/timing";
import { achievement } from "@/lib/analytics/achievement";
import { median, type Rate } from "@/lib/analytics/stats";
import type { FactRow, RoutineInfo, VersionInfo } from "@/lib/analytics/types";
import { addDays, isoWeekday, jstDate } from "@/lib/time/jst";
import * as T from "./thresholds";

export const RULE_IDS = ["R-01", "R-02", "R-03"] as const;
export type RuleId = (typeof RULE_IDS)[number];
export const RULE_TITLE: Record<RuleId, string> = {
  "R-01": "開始の遅れが続いています",
  "R-02": "特定の曜日にうまくいっていません",
  "R-03": "所要時間が足りていません",
};

/** 提案で変える設定（DB の proposed / current_settings と同じ形） */
export type PlanSettings = { weekdays: number[]; start_time: string; duration_min: number };

/** 判断の記録（suggestions の行） */
export type Decision = {
  id: string;
  routine_id: string;
  rule_id: string;
  base_version_id: string;
  status: "accepted" | "rejected";
  decided_at: string;
  applied_version_id: string | null;
  evidence: Record<string, unknown>;
  current_settings: PlanSettings;
  proposed: PlanSettings;
};

/** 根拠（DB の evidence にそのまま保存する） */
export type Evidence =
  | ({ rule: "R-01"; medianDelay: number; samples: number; shiftMin: number; plannedExcluded: number; lateDayExcluded: number } & Common)
  | ({ rule: "R-02"; weekday: number; day: RateLite; others: RateLite; gapPoints: number } & Common)
  | ({ rule: "R-03"; medianRatio: number; medianActual: number; samples: number } & Common);
type Common = { from: string; to: string; versionNo: number; finals: number; rate: RateLite };
export type RateLite = { num: number; den: number };

export type Suggestion = {
  ruleId: RuleId;
  routineId: string;
  routineName: string;
  baseVersionId: string;
  baseVersionNo: number;
  current: PlanSettings;
  proposed: PlanSettings;
  evidence: Evidence;
  /** 少ない件数による傾向（R-02 は常に true：「参考傾向」と表示する） */
  tentative: boolean;
};

/** 提案が出なかった理由（「データ不足」などを画面で示すため） */
export type RoutineNote = {
  routineId: string;
  routineName: string;
  /** 今の版で、期間内に確定した予定の件数 */
  finals: number;
  /** 判断済みで、今は出さないルール（until：出せるようになる日。null は「この版では判断済み」） */
  suppressed: { ruleId: RuleId; until: string | null }[];
};

export type SuggestionInput = {
  facts: readonly FactRow[];
  routines: readonly (RoutineInfo & { name: string })[];
  versions: readonly VersionInfo[];
  decisions: readonly Decision[];
  /** 今日（JST） */
  today: string;
};

export type SuggestionResult = { suggestions: Suggestion[]; notes: RoutineNote[]; window: { from: string; to: string } };

export const hhmmOf = (t: string) => t.slice(0, 5);
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmmFrom = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const lite = (r: Rate): RateLite => ({ num: r.num, den: r.den });
const EPS = 1e-9;

export function settingsOf(v: VersionInfo): PlanSettings {
  return { weekdays: [...v.weekdays].sort((a, b) => a - b), start_time: hhmmOf(v.start_time), duration_min: v.duration_min };
}

/** 判定の期間（昨日までの 28 日） */
export function suggestionWindow(today: string): { from: string; to: string } {
  return { from: addDays(today, -T.WINDOW_DAYS), to: addDays(today, -1) };
}

/** 判断した日から 28 日間は出さない：出せるようになる日（判断日＋28 日） */
export function suppressedUntil(decidedAt: string): string {
  return addDays(jstDate(new Date(decidedAt)), T.SUPPRESS_DAYS);
}

/** R-01：遅れの中央値（実測・時刻指定だけ、翌日以降の実施を除く）が 20 分以上 → 開始時刻を 15 分単位で遅らせる */
export function ruleR01(rows: readonly FactRow[], cur: PlanSettings): { proposed: PlanSettings; ev: Omit<Extract<Evidence, { rule: "R-01" }>, keyof Common> } | null {
  const done = executedRows(rows, "all");
  const measured = executedRows(rows, "measured");
  const usable = measured.filter((r) => !r.is_late_day);
  if (usable.length < T.R01_MIN_SAMPLES) return null;
  const med = median(usable.map(delayOf))!;
  if (med < T.R01_MIN_DELAY_MIN) return null;
  const shift = Math.max(T.R01_STEP_MIN, Math.round(med / T.R01_STEP_MIN) * T.R01_STEP_MIN);
  const start = minutesOf(cur.start_time) + shift;
  if (start >= 24 * 60) return null; // 日付をまたぐ変更は提案しない
  return {
    proposed: { ...cur, start_time: hhmmFrom(start) },
    ev: {
      rule: "R-01",
      medianDelay: med,
      samples: usable.length,
      shiftMin: shift,
      plannedExcluded: done.length - measured.length,
      lateDayExcluded: measured.length - usable.length,
    },
  };
}

/**
 * R-02：ある曜日の達成率が 40% 未満で、ほかの曜日（まとめた達成率）より 30 ポイント以上低い → その曜日を外す。
 * 件数：その曜日・ほかの曜日それぞれ確定 3 件以上（全体 5 件以上は共通の条件）。曜日が1つだけなら出さない。
 * 複数の曜日が当てはまるときは、達成率がいちばん低い曜日（同じなら差が大きい曜日、さらに同じなら早い曜日）。
 */
export function ruleR02(rows: readonly FactRow[], cur: PlanSettings): { proposed: PlanSettings; ev: Omit<Extract<Evidence, { rule: "R-02" }>, keyof Common> } | null {
  if (cur.weekdays.length < 2) return null;
  const finals = rows.filter((r) => r.is_final);
  type Cand = { weekday: number; day: Rate; others: Rate; gap: number };
  const cands: Cand[] = [];
  for (const d of cur.weekdays) {
    const day = achievement(finals.filter((r) => r.planned_weekday === d));
    const others = achievement(finals.filter((r) => r.planned_weekday !== d));
    if (day.den < T.R02_MIN_DAY_FINAL || others.den < T.R02_MIN_DAY_FINAL) continue;
    const gap = (others.rate! - day.rate!) * 100;
    if (day.rate! < T.R02_MAX_RATE - EPS && gap >= T.R02_MIN_GAP_POINTS - EPS) cands.push({ weekday: d, day, others, gap });
  }
  cands.sort((a, b) => a.day.rate! - b.day.rate! || b.gap - a.gap || a.weekday - b.weekday);
  const c = cands[0];
  if (!c) return null;
  return {
    proposed: { ...cur, weekdays: cur.weekdays.filter((d) => d !== c.weekday) },
    ev: { rule: "R-02", weekday: c.weekday, day: lite(c.day), others: lite(c.others), gapPoints: Math.round(c.gap) },
  };
}

/** R-03：実際の所要時間 ÷ 予定 の中央値が 1.3 以上 → 所要時間を実際の中央値に（5 分単位で切り上げ、480 分まで） */
export function ruleR03(rows: readonly FactRow[], cur: PlanSettings): { proposed: PlanSettings; ev: Omit<Extract<Evidence, { rule: "R-03" }>, keyof Common> } | null {
  const xs = executedRows(rows, "all").filter((r) => r.actual_duration_min !== null);
  if (xs.length < T.R03_MIN_SAMPLES) return null;
  const ratio = median(xs.map((r) => r.actual_duration_min! / r.planned_duration_min))!;
  if (ratio < T.R03_MIN_RATIO - EPS) return null;
  const actual = median(xs.map((r) => r.actual_duration_min!))!;
  const proposed = Math.min(T.DURATION_MAX, Math.ceil(actual / T.R03_STEP_MIN) * T.R03_STEP_MIN);
  if (proposed <= cur.duration_min) return null;
  return {
    proposed: { ...cur, duration_min: proposed },
    ev: { rule: "R-03", medianRatio: Math.round(ratio * 100) / 100, medianActual: actual, samples: xs.length },
  };
}

const RULES = { "R-01": ruleR01, "R-02": ruleR02, "R-03": ruleR03 } as const;

export function generateSuggestions(input: SuggestionInput): SuggestionResult {
  const window = suggestionWindow(input.today);
  const suggestions: Suggestion[] = [];
  const notes: RoutineNote[] = [];
  for (const routine of input.routines) {
    if (routine.archived_at || routine.exclude_from_analytics) continue;
    const cur = input.versions.find((v) => v.routine_id === routine.id && v.valid_to === null);
    if (!cur) continue;
    const rows = input.facts.filter(
      (r) => r.routine_version_id === cur.id && r.planned_date >= window.from && r.planned_date <= window.to && r.status !== "cancelled",
    );
    const overall = achievement(rows);
    const suppressed: RoutineNote["suppressed"] = [];
    for (const ruleId of RULE_IDS) {
      const ds = input.decisions.filter((d) => d.routine_id === routine.id && d.rule_id === ruleId);
      const until = ds.map((d) => suppressedUntil(d.decided_at)).sort().at(-1);
      if (until && until > input.today) suppressed.push({ ruleId, until });
      else if (ds.some((d) => d.base_version_id === cur.id)) suppressed.push({ ruleId, until: null });
    }
    notes.push({ routineId: routine.id, routineName: routine.name, finals: overall.den, suppressed });
    if (overall.den < T.MIN_FINAL) continue;
    const current = settingsOf(cur);
    for (const ruleId of RULE_IDS) {
      if (suppressed.some((s) => s.ruleId === ruleId)) continue;
      const hit = RULES[ruleId](rows, current);
      if (!hit) continue;
      suggestions.push({
        ruleId,
        routineId: routine.id,
        routineName: routine.name,
        baseVersionId: cur.id,
        baseVersionNo: cur.version_no,
        current,
        proposed: hit.proposed,
        evidence: { ...hit.ev, from: window.from, to: window.to, versionNo: cur.version_no, finals: overall.den, rate: lite(overall) } as Evidence,
        tentative: ruleId === "R-02",
      });
    }
  }
  return { suggestions, notes, window };
}

/** R-02 で外す曜日の、これからの予定日（適用開始日以降、count 回分） */
export function removedDates(weekday: number, from: string, count = 4): string[] {
  const out: string[] = [];
  for (let d = from; out.length < count; d = addDays(d, 1)) if (isoWeekday(d) === weekday) out.push(d);
  return out;
}

/** 確認画面の変更理由の既定値 */
export function defaultReason(s: Suggestion): string {
  const e = s.evidence;
  if (e.rule === "R-01") return `改善提案 R-01：開始の遅れ（中央値 +${Math.round(e.medianDelay)}分）`;
  if (e.rule === "R-02") return `改善提案 R-02：曜日の見直し（達成率 ${e.day.num}/${e.day.den}件）`;
  return `改善提案 R-03：所要時間の見直し（実際は予定の${e.medianRatio}倍）`;
}

/** 取り消し（元の設定に戻す）のときの変更理由 */
export function revertReason(ruleId: string): string {
  return `改善提案 ${ruleId} の取り消し`;
}

