// 分析の純粋関数（src/lib/analytics/、docs/phase3-plan.md 3〜4章）を固定データで確かめる。
import { describe, expect, it } from "vitest";
import { achievement, byDay, byTimeBand, byWeek, byWeekday, countOutcomes, weekStart } from "@/lib/analytics/achievement";
import { recentTrend, routineSummaries, streaks } from "@/lib/analytics/continuity";
import { failureStats, postponeStats, reasonShare } from "@/lib/analytics/reasons";
import { analyze, periodRange, targetRoutines } from "@/lib/analytics/report";
import { diffPoints, formatMinutes, formatPoints, formatRate, mean, median, rate } from "@/lib/analytics/stats";
import { delayBucket, delayStats, durationStats } from "@/lib/analytics/timing";
import type { FactRow, ReasonEventRow, RoutineInfo, VersionInfo } from "@/lib/analytics/types";
import { compareWithPrevious, versionStats } from "@/lib/analytics/versions";
import { timeBand } from "@/lib/time/bands";
import { addDays, isoWeekday, jstDateTimeToInstant } from "@/lib/time/jst";

let seq = 0;
type Over = Partial<FactRow> & { date?: string; time?: string; start?: string | null; delay?: number };
/** 予定1回分の行。date・time（JST）から予定日・曜日・時間帯・予定時刻を作る。delay を渡すと完了＋実績つき */
function fact(o: Over = {}): FactRow {
  seq += 1;
  const date = o.date ?? "2026-11-10";
  const time = o.time ?? "07:00";
  const planned = jstDateTimeToInstant(date, time);
  const done = o.delay !== undefined;
  const actual = done ? new Date(planned.getTime() + o.delay! * 60000) : null;
  const status = o.status ?? (done ? "done" : "scheduled");
  return {
    occurrence_id: `occ-${seq}`,
    routine_id: "r1",
    routine_version_id: "v1",
    version_no: 1,
    planned_date: date,
    planned_weekday: isoWeekday(date),
    planned_start_at: planned.toISOString(),
    time_band: timeBand(time),
    planned_duration_min: 15,
    status,
    is_final: ["done", "skipped", "missed"].includes(status),
    postpone_count: 0,
    actual_start_at: actual?.toISOString() ?? null,
    actual_duration_min: done ? 15 : null,
    executed_date: done ? date : null,
    is_late_day: done ? false : null,
    start_source: done ? "now" : null,
    delay_min: done ? o.delay! : null,
    closing_reason_code: null,
    ...o,
  } as FactRow;
}
const ev = (occ: FactRow, over: Partial<ReasonEventRow>): ReasonEventRow => ({
  event_id: ++seq, occurrence_id: occ.occurrence_id, routine_id: occ.routine_id, planned_date: occ.planned_date,
  type: "postponed", reason_code: null, postpone_option: "10m", ...over,
});

describe("stats：割合・中央値・表示", () => {
  it("分母が0なら「データなし」（0% にしない）。1〜4件は参考値、5件から参考値ではない", () => {
    expect(rate(0, 0)).toEqual({ num: 0, den: 0, rate: null, reference: false });
    expect(formatRate(rate(0, 0))).toBe("データなし");
    expect(rate(2, 3)).toMatchObject({ rate: 2 / 3, reference: true });
    expect(formatRate(rate(2, 3))).toBe("67%（2/3件）");
    expect(rate(4, 5).reference).toBe(false);
  });
  it("中央値（奇数・偶数）と平均。0件は null", () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 20, 30])).toBe(25);
    expect(median([])).toBeNull();
    expect(mean([10, 20, 60])).toBe(30);
  });
  it("差のポイントと分の表示", () => {
    expect(diffPoints(rate(3, 4), rate(1, 4))).toBe(50);
    expect(diffPoints(rate(3, 4), rate(0, 0))).toBeNull();
    expect([formatPoints(12.4), formatPoints(-5), formatPoints(0.2), formatPoints(null)]).toEqual(["+12pt", "−5pt", "±0pt", "—"]);
    expect([formatMinutes(3.6), formatMinutes(-2), formatMinutes(0), formatMinutes(null)]).toEqual(["+4分", "−2分", "0分", "データなし"]);
  });
});

describe("達成率：確定した予定だけを数える", () => {
  it("延期→完了は完了、延期→見送り・未実施は失敗。未確定と取り消しは分母に入れない", () => {
    const rows = [
      fact({ delay: 0, postpone_count: 2 }),
      fact({ status: "skipped", postpone_count: 1 }),
      fact({ status: "missed" }),
      fact({ status: "scheduled" }),
      fact({ status: "notified" }),
      fact({ status: "postponed", postpone_count: 1 }),
      fact({ status: "cancelled" }),
    ];
    expect(countOutcomes(rows)).toEqual({ done: 1, skipped: 1, missed: 1, open: 3, cancelled: 1 });
    expect(achievement(rows)).toMatchObject({ num: 1, den: 3 });
    expect(achievement([fact({ status: "scheduled" })]).rate).toBeNull();
  });

  it("日別：予定のない日も「データなし」で並べる", () => {
    const d = byDay([fact({ date: "2026-11-10", delay: 0 })], "2026-11-09", "2026-11-11");
    expect(d.map((b) => [b.key, b.rate.rate])).toEqual([["2026-11-09", null], ["2026-11-10", 1], ["2026-11-11", null]]);
  });

  it("週別は月曜始まり（日曜 23:59 と月曜 0:00 の境界、年末）", () => {
    expect(weekStart("2026-11-15")).toBe("2026-11-09"); // 日曜 → その週の月曜
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
    expect(weekStart("2027-01-01")).toBe("2026-12-28"); // 年をまたぐ週
    const rows = [
      fact({ date: "2026-11-15", time: "23:55", delay: 0 }),
      fact({ date: "2026-11-16", time: "00:00", status: "skipped" }),
    ];
    const w = byWeek(rows, "2026-11-12", "2026-11-18");
    expect(w.map((b) => [b.key, b.outcome.done, b.outcome.skipped])).toEqual([["2026-11-09", 1, 0], ["2026-11-16", 0, 1]]);
  });

  it("曜日別・時間帯別：区分ごとの達成率と、それ以外の区分との差", () => {
    const rows = [
      fact({ date: "2026-11-09", delay: 0 }), // 月 完了
      fact({ date: "2026-11-16", delay: 0 }), // 月 完了
      fact({ date: "2026-11-10", status: "skipped" }), // 火
      fact({ date: "2026-11-17", delay: 0 }), // 火
    ];
    const mon = byWeekday(rows).find((s) => s.key === 1)!;
    expect(mon.rate).toMatchObject({ num: 2, den: 2 });
    expect(mon.others).toMatchObject({ num: 1, den: 2 });
    expect(mon.diff).toBe(50);
    expect(byWeekday(rows).find((s) => s.key === 7)!.rate.rate).toBeNull();
  });

  it("時間帯の境界（3:59 は深夜・4:00 は早朝、21:59 は夜・22:00 は深夜）", () => {
    const rows = ["03:59", "04:00", "21:59", "22:00"].map((t) => fact({ time: t, delay: 0 }));
    const n = Object.fromEntries(byTimeBand(rows).map((s) => [s.key, s.outcome.done]));
    expect(n).toMatchObject({ night: 2, early: 1, evening: 1, morning: 0 });
  });
});

describe("遅延と所要時間：「予定どおり」の入力と実測を分ける", () => {
  it("分布の境界：±10分ちょうどは予定どおり、30・60分ちょうどはその区分。翌日以降は別", () => {
    const b = (delay: number, late = false) => delayBucket(fact({ delay, is_late_day: late }));
    expect([b(-11), b(-10), b(10), b(11), b(30), b(31), b(60), b(61), b(900, true)]).toEqual([
      "early", "onTime", "onTime", "late30", "late30", "late60", "late60", "lateOver", "lateDay",
    ]);
  });

  it("中央値・平均・±10分以内・翌日以降の割合。未完了は数えない", () => {
    const rows = [
      fact({ delay: 5 }), fact({ delay: 15 }), fact({ delay: 25 }),
      fact({ delay: 1500, is_late_day: true, executed_date: "2026-11-11" }),
      fact({ status: "skipped" }),
    ];
    const s = delayStats(rows);
    expect(s.median).toEqual({ n: 4, value: 20, reference: true });
    expect(s.mean.value).toBe((5 + 15 + 25 + 1500) / 4);
    expect(s.onTime).toMatchObject({ num: 1, den: 4 });
    expect(s.lateDay).toMatchObject({ num: 1, den: 4 });
  });

  it("「予定どおり」で記録した0分と、実測の0分を分けて数え、実測だけに絞れる", () => {
    const rows = [
      fact({ delay: 0, start_source: "planned" }),
      fact({ delay: 0, start_source: "planned" }),
      fact({ delay: 0, start_source: "now" }),
      fact({ delay: 40, start_source: "timer" }),
      fact({ delay: 20, start_source: "manual" }),
    ];
    const all = delayStats(rows, "all");
    expect(all.sources).toEqual({ planned: 2, measured: 3 });
    expect(all.measuredZero).toBe(1);
    expect(all.median.value).toBe(0);
    const measured = delayStats(rows, "measured");
    expect(measured.median).toEqual({ n: 3, value: 20, reference: true });
    expect(measured.sources).toEqual({ planned: 0, measured: 3 });
  });

  it("所要時間：実際÷予定の中央値、差の中央値、長かった・短かった割合", () => {
    const rows = [
      fact({ delay: 0, actual_duration_min: 30 }), // 2.0
      fact({ delay: 0, actual_duration_min: 15 }), // 1.0
      fact({ delay: 0, actual_duration_min: 10 }), // 0.67
      fact({ status: "skipped" }),
    ];
    const d = durationStats(rows);
    expect(d.ratio).toEqual({ n: 3, value: 1, reference: true });
    expect(d.diff.value).toBe(0);
    expect(d.longer).toMatchObject({ num: 1, den: 3 });
    expect(d.shorter).toMatchObject({ num: 1, den: 3 });
    expect(durationStats([]).ratio).toEqual({ n: 0, value: null, reference: false });
  });
});

describe("延期と、見送り・未実施の内訳", () => {
  it("延期した割合・回数の分布・延期後の結果・選択肢と理由（対象の予定の分だけ）", () => {
    const a = fact({ delay: 30, postpone_count: 1 });
    const b = fact({ status: "skipped", postpone_count: 3, closing_reason_code: "no_time" });
    const c = fact({ delay: 0 });
    const d = fact({ status: "postponed", postpone_count: 1 }); // 未確定：割合・分布には入らない
    const other = fact({ routine_id: "r2", status: "postponed", postpone_count: 1 });
    const events = [
      ev(a, { postpone_option: "30m", reason_code: "tired" }),
      ev(b, { postpone_option: "10m", reason_code: "no_time" }),
      ev(b, { postpone_option: "10m", reason_code: null }),
      ev(b, { postpone_option: "1h", reason_code: "no_time" }),
      ev(b, { type: "skipped", postpone_option: null, reason_code: "no_time" }),
      ev(d, { postpone_option: "today_at" }),
      ev(other, { postpone_option: "1h" }), // 対象外の予定
    ];
    const s = postponeStats([a, b, c, d], events);
    expect(s.postponed).toMatchObject({ num: 2, den: 3 });
    expect(s.countDist).toEqual({ "0": 1, "1": 1, "2": 0, "3+": 1 });
    expect(s.outcome).toMatchObject({ done: 1, skipped: 1, missed: 0 });
    expect(s.afterRate).toMatchObject({ num: 1, den: 2 });
    expect(s.events).toBe(5);
    expect(s.options).toEqual({ "10m": 2, "30m": 1, "1h": 1, today_at: 1, tomorrow_same: 0 });
    expect(s.reasons).toMatchObject({ no_time: 2, tired: 1, none: 2 });
    expect(s.delayAfter).toEqual({ n: 1, value: 30, reference: true });
    // 延期・見送り・未実施のうち「時間がなかった」の割合（理由のあるものの中で）
    expect(reasonShare([a, b, c, d], events, "no_time")).toMatchObject({ num: 3, den: 4 });
  });

  it("見送り・未実施の理由（理由なしを含む）と、多い曜日×時間帯", () => {
    const rows = [
      fact({ date: "2026-11-09", time: "22:00", status: "skipped", closing_reason_code: "tired" }),
      fact({ date: "2026-11-16", time: "22:00", status: "missed" }),
      fact({ date: "2026-11-23", time: "22:00", delay: 0, executed_date: "2026-11-23" }),
      fact({ date: "2026-11-10", time: "07:00", status: "skipped", closing_reason_code: "plans" }),
    ];
    const f = failureStats(rows);
    expect([f.skipped, f.missed]).toEqual([2, 1]);
    expect(f.reasons.skipped).toMatchObject({ tired: 1, plans: 1, none: 0 });
    expect(f.reasons.missed).toMatchObject({ none: 1 });
    expect(f.combos).toEqual([
      { weekday: 1, band: "night", failures: 2, total: 3 },
      { weekday: 2, band: "morning", failures: 1, total: 1 },
    ]);
  });
});

describe("継続：連続達成と直近4週の比較", () => {
  it("予定のない日は途切れない。見送り・未実施で途切れ、未確定と取り消しは飛ばす", () => {
    const rows = [
      fact({ date: "2026-11-02", delay: 0 }),
      fact({ date: "2026-11-04", delay: 0 }), // 11/3 は予定なし（行がない）
      fact({ date: "2026-11-06", delay: 0 }),
      fact({ date: "2026-11-09", status: "skipped" }),
      fact({ date: "2026-11-10", delay: 0 }),
      fact({ date: "2026-11-11", status: "cancelled" }),
      fact({ date: "2026-11-12", delay: 0 }),
      fact({ date: "2026-11-13", status: "postponed" }), // 未確定
    ];
    expect(streaks([...rows].reverse())).toEqual({ current: 2, longest: 3, finals: 6 });
    expect(streaks([fact({ date: "2026-11-10", status: "missed" })])).toEqual({ current: 0, longest: 0, finals: 1 });
    expect(streaks([])).toEqual({ current: 0, longest: 0, finals: 0 });
  });

  it("直近4週（今日を含む28日）と前の4週の達成率と差", () => {
    const today = "2026-12-06";
    const rows = [
      fact({ date: "2026-12-06", delay: 0 }),
      fact({ date: "2026-11-09", status: "skipped" }), // 直近の最初の日
      fact({ date: "2026-11-08", delay: 0 }), // 前の4週の最後の日
      fact({ date: "2026-10-12", status: "missed" }), // 前の4週の最初の日
      fact({ date: "2026-10-11", delay: 0 }), // どちらにも入らない
    ];
    const t = recentTrend(rows, today);
    expect(t.recent).toMatchObject({ from: "2026-11-09", to: "2026-12-06", rate: { num: 1, den: 2 } });
    expect(t.previous).toMatchObject({ from: "2026-10-12", to: "2026-11-08", rate: { num: 1, den: 2 } });
    expect(t.diff).toBe(0);
    expect(recentTrend([], today).diff).toBeNull();
  });
});

const R = (id: string, over: Partial<RoutineInfo> = {}): RoutineInfo => ({ id, name: id, archived_at: null, exclude_from_analytics: false, ...over });
const V = (id: string, no: number, from: string, to: string | null): VersionInfo => ({
  id, routine_id: "r1", version_no: no, start_time: "07:00:00", duration_min: 15, weekdays: [1, 2, 3, 4, 5, 6, 7], valid_from: from, valid_to: to, source: "manual",
});

describe("版ごとの集計と変更前後の比較の準備", () => {
  const versions = [V("v1", 1, "2026-10-01", "2026-11-10"), V("v2", 2, "2026-11-10", "2026-11-10"), V("v3", 3, "2026-11-10", null)];
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => fact({ date: addDays("2026-10-11", i), routine_version_id: "v1", ...(i % 2 ? { delay: 0 } : { status: "skipped" as const }) })),
    ...Array.from({ length: 10 }, (_, i) => fact({ date: addDays("2026-11-10", i), routine_version_id: "v3", delay: 5 })),
  ];

  it("版ごとの件数・達成率（一度も有効にならなかった版は除く）", () => {
    const s = versionStats(rows, versions);
    expect(s.map((x) => [x.version.version_no, x.from, x.to, x.stats.rate.num, x.stats.rate.den])).toEqual([
      [3, "2026-11-10", null, 10, 10],
      [1, "2026-10-01", "2026-11-09", 15, 30],
    ]);
  });

  it("直前の版と、同じ長さの期間（変更後の経過日数に合わせる）で比べ、期間と件数の注意を出す", () => {
    const c = compareWithPrevious(rows, versions, "v3", "2026-11-19")!;
    expect(c.days).toBe(10);
    expect([c.after.from, c.after.to, c.before.from, c.before.to]).toEqual(["2026-11-10", "2026-11-19", "2026-10-31", "2026-11-09"]);
    expect(c.after.stats.rate).toMatchObject({ num: 10, den: 10 });
    expect(c.before.stats.rate).toMatchObject({ num: 5, den: 10 });
    expect(c.warnings).toEqual(["比べられる期間が 10 日だけです（目安は 28 日）。"]);
    expect(compareWithPrevious(rows, versions, "v1", "2026-11-19")).toBeNull(); // 最初の版
    expect(compareWithPrevious(rows, versions, "v3", "2026-11-09")).toBeNull(); // まだ始まっていない
  });

  it("件数が5件未満なら注意を出す", () => {
    const c = compareWithPrevious(rows.slice(0, 31), versions, "v3", "2026-11-12")!;
    expect(c.days).toBe(3);
    expect(c.warnings).toContain("変更前の確定した予定が 3 件だけです（5件未満は参考値）。");
    expect(c.warnings).toContain("変更後の確定した予定が 1 件だけです（5件未満は参考値）。");
  });
});

describe("期間・テスト用の除外・全体の集計", () => {
  it("期間：直近7日・4週・12週（今日を含む）。指定は正しい順序で1年まで", () => {
    expect(periodRange("7d", "2026-11-10")).toEqual({ from: "2026-11-04", to: "2026-11-10" });
    expect(periodRange("4w", "2026-11-10")).toEqual({ from: "2026-10-14", to: "2026-11-10" });
    expect(periodRange("12w", "2026-11-10")!.from).toBe("2026-08-19");
    expect(periodRange("custom", "2026-11-10", { from: "2026-11-01", to: "2026-11-05" })).toEqual({ from: "2026-11-01", to: "2026-11-05" });
    expect(periodRange("custom", "2026-11-10", { from: "2026-11-05", to: "2026-11-01" })).toBeNull();
    expect(periodRange("custom", "2026-11-10", { from: "2025-11-01", to: "2026-11-05" })).toBeNull();
    expect(periodRange("custom", "2026-11-10", {})).toBeNull();
  });

  it("「分析に含めない」のルーティンは既定で外し、「含める」・そのルーティンを選んだときだけ入れる（記録は変えない）", () => {
    const routines = [R("real"), R("test", { exclude_from_analytics: true })];
    const facts = [fact({ routine_id: "real", delay: 0 }), fact({ routine_id: "test", status: "skipped" }), fact({ routine_id: "test", status: "skipped" })];
    const base = { facts, events: [], routines, today: "2026-11-12" };
    const range = { from: "2026-11-01", to: "2026-11-12" };
    const def = analyze(base, { range, routineId: null, includeExcluded: false, filter: "all" });
    expect(def.rate).toMatchObject({ num: 1, den: 1 });
    expect(def.excludedCount).toBe(1);
    expect(def.perRoutine.map((p) => p.routine.id)).toEqual(["real"]);
    expect(analyze(base, { range, routineId: null, includeExcluded: true, filter: "all" }).rate).toMatchObject({ num: 1, den: 3 });
    expect(analyze(base, { range, routineId: "test", includeExcluded: false, filter: "all" }).rate).toMatchObject({ num: 0, den: 2 });
    expect(targetRoutines(routines, { routineId: null, includeExcluded: false }).map((r) => r.id)).toEqual(["real"]);
    expect(facts).toHaveLength(3);
  });

  it("期間外の行は数えず、期間の終わりが直近（未実施の確定前）なら知らせる", () => {
    const facts = [fact({ date: "2026-11-01", delay: 0 }), fact({ date: "2026-10-01", status: "missed" })];
    const input = { facts, events: [], routines: [R("r1")], today: "2026-11-12" };
    const r = analyze(input, { range: { from: "2026-10-20", to: "2026-11-12" }, routineId: null, includeExcluded: false, filter: "all" });
    expect(r.rate).toMatchObject({ num: 1, den: 1 });
    expect(r.includesRecent).toBe(true);
    expect(analyze(input, { range: { from: "2026-10-01", to: "2026-11-05" }, routineId: null, includeExcluded: false, filter: "all" }).includesRecent).toBe(false);
  });

  it("ルーティンごとの一覧：期間の達成率と、全期間の連続達成・直近4週の比較", () => {
    const facts = [
      fact({ date: "2026-10-01", delay: 0 }),
      fact({ date: "2026-11-10", delay: 0 }),
      fact({ date: "2026-11-11", delay: 0 }),
    ];
    const [s] = routineSummaries([R("r1")], facts.slice(1), facts, "2026-11-12");
    expect(s!.rate).toMatchObject({ num: 2, den: 2 });
    expect(s!.streaks.current).toBe(3);
    expect(s!.trend.recent.rate).toMatchObject({ num: 2, den: 2 }); // 10/16〜11/12
    expect(s!.trend.previous.rate).toMatchObject({ num: 1, den: 1 }); // 9/18〜10/15
  });

  it("1年分（5ルーティン×365日）でもすぐに集計できる", () => {
    const routines = ["a", "b", "c", "d", "e"].map((id) => R(id));
    const facts: FactRow[] = [];
    for (const r of routines) {
      for (let i = 0; i < 365; i++) {
        const st = i % 4 === 0 ? { status: "skipped" as const } : { delay: (i % 50) - 10 };
        facts.push(fact({ routine_id: r.id, date: addDays("2025-11-13", i), time: `${String(5 + (i % 18)).padStart(2, "0")}:00`, ...st }));
      }
    }
    const t0 = performance.now();
    const rep = analyze({ facts, events: [], routines, today: "2026-11-12" }, { range: { from: "2025-11-13", to: "2026-11-12" }, routineId: null, includeExcluded: false, filter: "all" });
    const ms = performance.now() - t0;
    expect(rep.outcome.done + rep.outcome.skipped).toBe(1825);
    expect(ms).toBeLessThan(1000);
  });
});
