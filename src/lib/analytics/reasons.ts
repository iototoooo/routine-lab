// 延期と、見送り・未実施の内訳（要件 F-508）。
import { POSTPONE_OPTIONS, type PostponeOption } from "@/lib/domain/postpone";
import { REASON_CODES, type ReasonCode } from "@/lib/domain/reasons";
import type { TimeBand } from "@/lib/time/bands";
import { countOutcomes, type Outcome } from "./achievement";
import { countBy, median, rate, sample, type Rate, type Sample } from "./stats";
import { delayOf, executedRows } from "./timing";
import type { FactRow, ReasonEventRow } from "./types";

/** 理由の区分（7種類＋理由なし） */
export const REASON_KEYS = [...REASON_CODES, "none"] as const;
export type ReasonKey = (typeof REASON_KEYS)[number];
const reasonKey = (c: ReasonCode | null): ReasonKey => c ?? "none";

export const POSTPONE_COUNT_KEYS = ["0", "1", "2", "3+"] as const;
export type PostponeCountKey = (typeof POSTPONE_COUNT_KEYS)[number];
const countKey = (n: number): PostponeCountKey => (n >= 3 ? "3+" : (String(n) as PostponeCountKey));

export type PostponeStats = {
  /** 確定した予定のうち、1回以上延期したものの割合 */
  postponed: Rate;
  /** 確定した予定ごとの延期回数の分布 */
  countDist: Record<PostponeCountKey, number>;
  /** 延期した（確定済みの）予定の最終結果。rate は延期後の達成率 */
  outcome: Outcome;
  afterRate: Rate;
  /** 延期の操作1回ごとの選択肢・理由（延期中の予定の分も含む） */
  events: number;
  options: Record<PostponeOption, number>;
  reasons: Record<ReasonKey, number>;
  /** 延期してから完了したときの遅延（分）の中央値 */
  delayAfter: Sample;
};

export function postponeStats(rows: readonly FactRow[], events: readonly ReasonEventRow[]): PostponeStats {
  const final = rows.filter((r) => r.is_final);
  const postponedFinal = final.filter((r) => r.postpone_count > 0);
  const outcome = countOutcomes(postponedFinal);
  const ids = new Set(rows.map((r) => r.occurrence_id));
  const ev = events.filter((e) => e.type === "postponed" && ids.has(e.occurrence_id));
  return {
    postponed: rate(postponedFinal.length, final.length),
    countDist: countBy(POSTPONE_COUNT_KEYS, final.map((r) => countKey(r.postpone_count))),
    outcome,
    afterRate: rate(outcome.done, outcome.done + outcome.skipped + outcome.missed),
    events: ev.length,
    options: countBy(POSTPONE_OPTIONS, ev.flatMap((e) => (e.postpone_option ? [e.postpone_option] : []))),
    reasons: countBy(REASON_KEYS, ev.map((e) => reasonKey(e.reason_code))),
    delayAfter: sample(executedRows(rows).filter((r) => r.postpone_count > 0).map(delayOf), median),
  };
}

export type FailureCombo = { weekday: number; band: TimeBand; failures: number; total: number };

export type FailureStats = {
  skipped: number;
  missed: number;
  reasons: { skipped: Record<ReasonKey, number>; missed: Record<ReasonKey, number> };
  /** 見送り・未実施の多い「曜日×時間帯」（多い順に最大3つ。total は確定した予定の数） */
  combos: FailureCombo[];
};

export function failureStats(rows: readonly FactRow[]): FailureStats {
  const skipped = rows.filter((r) => r.status === "skipped");
  const missed = rows.filter((r) => r.status === "missed");
  const map = new Map<string, FailureCombo>();
  for (const r of rows.filter((x) => x.is_final)) {
    const k = `${r.planned_weekday}|${r.time_band}`;
    const c = map.get(k) ?? { weekday: r.planned_weekday, band: r.time_band, failures: 0, total: 0 };
    c.total += 1;
    if (r.status !== "done") c.failures += 1;
    map.set(k, c);
  }
  const combos = [...map.values()]
    .filter((c) => c.failures > 0)
    .sort((a, b) => b.failures - a.failures || a.weekday - b.weekday)
    .slice(0, 3);
  return {
    skipped: skipped.length,
    missed: missed.length,
    reasons: {
      skipped: countBy(REASON_KEYS, skipped.map((r) => reasonKey(r.closing_reason_code))),
      missed: countBy(REASON_KEYS, missed.map((r) => reasonKey(r.closing_reason_code))),
    },
    combos,
  };
}

/** 延期・見送り・未実施をまとめた理由の内訳（Phase 4 の R-04「時間がなかった」が半数以上か、で使う） */
export function reasonShare(rows: readonly FactRow[], events: readonly ReasonEventRow[], code: ReasonCode): Rate {
  const ids = new Set(rows.map((r) => r.occurrence_id));
  const ev = events.filter((e) => ids.has(e.occurrence_id));
  const withReason = ev.filter((e) => e.reason_code !== null);
  return rate(withReason.filter((e) => e.reason_code === code).length, withReason.length);
}
