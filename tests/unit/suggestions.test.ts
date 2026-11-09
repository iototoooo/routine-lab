// 改善提案のルール（src/lib/suggestions/、docs/phase4-plan.md 2章）・版の比較・書き出しを固定データで確かめる。
import { describe, expect, it } from "vitest";
import type { FactRow, RoutineInfo, VersionInfo } from "@/lib/analytics/types";
import { compareVersions, compareWithPrevious } from "@/lib/analytics/versions";
import { buildJson, csvCell, exportFileName, factsCsv, toCsv, EXPORT_TABLES, type ExportData } from "@/lib/export/export";
import {
  defaultReason,
  generateSuggestions,
  removedDates,
  ruleR01,
  ruleR02,
  ruleR03,
  suggestionWindow,
  suppressedUntil,
  type Decision,
  type PlanSettings,
} from "@/lib/suggestions/rules";
import { timeBand } from "@/lib/time/bands";
import { addDays, isoWeekday, jstDateTimeToInstant } from "@/lib/time/jst";

const TODAY = "2026-11-30"; // 月曜。判定の期間は 11/2〜11/29
let seq = 0;
type Over = Partial<FactRow> & { date?: string; time?: string; delay?: number; dur?: number };
function fact(o: Over = {}): FactRow {
  seq += 1;
  const date = o.date ?? "2026-11-20";
  const time = o.time ?? "07:00";
  const planned = jstDateTimeToInstant(date, time);
  const done = o.delay !== undefined;
  const status = o.status ?? (done ? "done" : "scheduled");
  return {
    occurrence_id: `occ-${String(seq).padStart(4, "0")}`,
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
    actual_start_at: done ? new Date(planned.getTime() + o.delay! * 60000).toISOString() : null,
    actual_duration_min: done ? (o.dur ?? 15) : null,
    executed_date: done ? date : null,
    is_late_day: done ? false : null,
    start_source: done ? "now" : null,
    delay_min: done ? o.delay! : null,
    closing_reason_code: null,
    ...o,
  } as FactRow;
}
/** 11/2 からの n 日分（毎日） */
const days = (n: number, from = "2026-11-02") => Array.from({ length: n }, (_, i) => addDays(from, i));
const doneOn = (dates: string[], delay: number, extra: Over = {}) => dates.map((date) => fact({ date, delay, ...extra }));

const CUR: PlanSettings = { weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:00", duration_min: 15 };
const V1: VersionInfo = { id: "v1", routine_id: "r1", version_no: 1, start_time: "07:00:00", duration_min: 15, weekdays: [1, 2, 3, 4, 5, 6, 7], valid_from: "2026-10-01", valid_to: null, source: "manual" };
const R1: RoutineInfo & { name: string } = { id: "r1", name: "ストレッチ", archived_at: null, exclude_from_analytics: false };

describe("R-01 慢性的な遅れ", () => {
  it("遅れの中央値 20 分以上で、中央値を 15 分単位に丸めた分だけ開始を遅らせる（19 分では出さない）", () => {
    expect(ruleR01(doneOn(days(5), 19), CUR)).toBeNull();
    const hit = ruleR01(doneOn(days(5), 20), CUR)!;
    expect(hit.proposed).toEqual({ ...CUR, start_time: "07:15" });
    expect(hit.ev).toMatchObject({ medianDelay: 20, samples: 5, shiftMin: 15 });
    expect(ruleR01(doneOn(days(5), 23), CUR)!.proposed.start_time).toBe("07:30");
    expect(ruleR01(doneOn(days(5), 52), CUR)!.proposed.start_time).toBe("07:45");
  });

  it("実測・時刻指定だけを使い、「予定どおり」（入力上の0分）と翌日以降の実施は数えない。4件以下なら出さない", () => {
    const rows = [
      ...doneOn(days(4), 30),
      fact({ date: "2026-11-10", delay: 0, start_source: "planned" }),
      fact({ date: "2026-11-11", delay: 0, start_source: "planned" }),
      fact({ date: "2026-11-12", delay: 1500, is_late_day: true }),
    ];
    expect(ruleR01(rows, CUR)).toBeNull(); // 使えるのは 4 件だけ
    const hit = ruleR01([...rows, fact({ date: "2026-11-13", delay: 25, start_source: "manual" })], CUR)!;
    expect(hit.ev).toMatchObject({ samples: 5, medianDelay: 30, plannedExcluded: 2, lateDayExcluded: 1 });
  });

  it("日付をまたぐ（24:00 以降になる）変更は提案しない", () => {
    expect(ruleR01(doneOn(days(5), 40), { ...CUR, start_time: "23:30" })).toBeNull();
    expect(ruleR01(doneOn(days(5), 20), { ...CUR, start_time: "23:30" })!.proposed.start_time).toBe("23:45");
  });
});

describe("R-02 特定の曜日の不調（参考傾向）", () => {
  // 11/2〜11/29：月曜は 11/2・9・16・23
  const mondays = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"];
  const others = days(28).filter((d) => !mondays.includes(d));
  const missOn = (dates: string[]) => dates.map((date) => fact({ date, status: "missed" }));

  it("その曜日 40% 未満・ほかより 30pt 以上低い → その曜日を外す。件数を根拠に入れる", () => {
    const rows = [...missOn(mondays.slice(0, 3)), ...doneOn(mondays.slice(3), 0), ...doneOn(others, 0)];
    const hit = ruleR02(rows, CUR)!;
    expect(hit.proposed.weekdays).toEqual([2, 3, 4, 5, 6, 7]);
    expect(hit.ev).toEqual({ rule: "R-02", weekday: 1, day: { num: 1, den: 4 }, others: { num: 24, den: 24 }, gapPoints: 75 });
  });

  it("その曜日の確定が 3 件以上必要（2 件なら出さない）。40% ちょうど・差 30pt 未満では出さない", () => {
    expect(ruleR02([...missOn(mondays.slice(0, 2)), ...doneOn(others, 0)], CUR)).toBeNull();
    expect(ruleR02([...missOn(mondays.slice(0, 3)), ...doneOn(others, 0)], CUR)).not.toBeNull();
    // 40%（2/5）ちょうどは出さない
    const fiveMon = [...mondays, "2026-11-30"];
    expect(ruleR02([...missOn(fiveMon.slice(0, 3)), ...doneOn(fiveMon.slice(3), 0), ...doneOn(others, 0)], CUR)).toBeNull();
    // 月曜 33%（1/3）・ほか 60%（3/5）：差 27pt なので出さない
    const tue = ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24", "2026-11-04"];
    expect(ruleR02([...missOn(mondays.slice(0, 2)), ...doneOn([mondays[2]!], 0), ...doneOn(tue.slice(0, 3), 0), ...missOn(tue.slice(3))], CUR)).toBeNull();
  });

  it("曜日が1つだけのルーティンには出さない", () => {
    expect(ruleR02(missOn(mondays), { ...CUR, weekdays: [1] })).toBeNull();
  });

  it("外す曜日のこれからの予定日を示せる", () => {
    expect(removedDates(1, "2026-12-01", 3)).toEqual(["2026-12-07", "2026-12-14", "2026-12-21"]);
  });
});

describe("R-03 所要時間の不足", () => {
  it("実際÷予定 の中央値 1.3 以上 → 実際の中央値に（5 分単位で切り上げ）。1.29 倍・4 件では出さない", () => {
    expect(ruleR03(doneOn(days(5), 0, { dur: 19 }), CUR)).toBeNull(); // 1.27 倍
    const hit = ruleR03(doneOn(days(5), 0, { dur: 20 }), CUR)!; // 1.33 倍
    expect(hit.proposed).toEqual({ ...CUR, duration_min: 20 });
    expect(hit.ev).toMatchObject({ medianRatio: 1.33, medianActual: 20, samples: 5 });
    expect(ruleR03(doneOn(days(4), 0, { dur: 30 }), CUR)).toBeNull();
    expect(ruleR03(doneOn(days(5), 0, { dur: 22 }), CUR)!.proposed.duration_min).toBe(25);
    expect(ruleR03(doneOn(days(5), 0, { dur: 700, planned_duration_min: 400 }), { ...CUR, duration_min: 400 })!.proposed.duration_min).toBe(480);
  });
});

describe("generateSuggestions：共通の決まり", () => {
  const input = (facts: FactRow[], over: Partial<Parameters<typeof generateSuggestions>[0]> = {}) =>
    generateSuggestions({ facts, routines: [R1], versions: [V1], decisions: [], today: TODAY, ...over });
  const lateAndLong = () => doneOn(days(6, "2026-11-20"), 30, { dur: 30 });

  it("期間は昨日までの 28 日。今の版で確定 5 件以上のとき、当てはまるルールをすべて出す（根拠に期間・版・件数）", () => {
    expect(suggestionWindow(TODAY)).toEqual({ from: "2026-11-02", to: "2026-11-29" });
    const r = input(lateAndLong());
    expect(r.suggestions.map((s) => s.ruleId)).toEqual(["R-01", "R-03"]);
    expect(r.suggestions[0]).toMatchObject({ routineId: "r1", routineName: "ストレッチ", baseVersionId: "v1", baseVersionNo: 1, tentative: false });
    expect(r.suggestions[0]!.evidence).toMatchObject({ from: "2026-11-02", to: "2026-11-29", versionNo: 1, finals: 6, rate: { num: 6, den: 6 } });
    expect(defaultReason(r.suggestions[0]!)).toBe("改善提案 R-01：開始の遅れ（中央値 +30分）");
  });

  it("確定 4 件以下・今日の予定・期間外・ほかの版の記録は数えない（無理に提案しない）", () => {
    const rows = [
      ...doneOn(days(4, "2026-11-20"), 30, { dur: 30 }),
      fact({ date: TODAY, delay: 30, dur: 30 }),
      fact({ date: "2026-11-01", delay: 30, dur: 30 }),
      fact({ date: "2026-11-21", delay: 30, dur: 30, routine_version_id: "v0" }),
      fact({ date: "2026-11-22", status: "scheduled" }),
    ];
    const r = input(rows);
    expect(r.suggestions).toEqual([]);
    expect(r.notes).toEqual([{ routineId: "r1", routineName: "ストレッチ", finals: 4, suppressed: [] }]);
  });

  it("テスト用（分析に含めない）・アーカイブ済みのルーティンには出さない", () => {
    expect(input(lateAndLong(), { routines: [{ ...R1, exclude_from_analytics: true }] }).suggestions).toEqual([]);
    expect(input(lateAndLong(), { routines: [{ ...R1, archived_at: "2026-11-25T00:00:00Z" }] }).notes).toEqual([]);
  });

  it("同じルーティン・同じルールは判断した日から 28 日間出さない（別のルールは出す）。今の版で判断済みなら出さない", () => {
    const d = (decided_at: string, rule_id = "R-01", base_version_id = "v0"): Decision => ({
      id: "d1", routine_id: "r1", rule_id, base_version_id, status: "rejected", decided_at, applied_version_id: null,
      evidence: {}, current_settings: CUR, proposed: CUR,
    });
    // 11/3 9:00 JST の却下 → 11/30 までは出さない、12/1 から出す
    const r = input(lateAndLong(), { decisions: [d("2026-11-03T00:00:00Z")] });
    expect(r.suggestions.map((s) => s.ruleId)).toEqual(["R-03"]);
    expect(r.notes[0]!.suppressed).toEqual([{ ruleId: "R-01", until: "2026-12-01" }]);
    expect(suppressedUntil("2026-11-02T15:00:00Z")).toBe("2026-12-01"); // JST 11/3 0:00
    expect(input(lateAndLong(), { decisions: [d("2026-11-02T14:59:00Z")] }).suggestions.map((s) => s.ruleId)).toEqual(["R-01", "R-03"]); // JST 11/2 → 11/30 から
    expect(input(lateAndLong(), { decisions: [d("2026-10-01T00:00:00Z", "R-03", "v1")] }).notes[0]!.suppressed).toEqual([{ ruleId: "R-03", until: null }]);
  });

  it("2 種類以上の提案（R-01・R-02・R-03）を同時に出せる", () => {
    const mondays = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"];
    const rows = [
      ...mondays.map((date) => fact({ date, status: "skipped" })),
      ...days(28).filter((x) => !mondays.includes(x)).map((date) => fact({ date, delay: 25, dur: 25 })),
    ];
    const r = input(rows);
    expect(r.suggestions.map((s) => s.ruleId)).toEqual(["R-01", "R-02", "R-03"]);
    expect(r.suggestions.find((s) => s.ruleId === "R-02")!.tentative).toBe(true);
  });
});

describe("版の比較（同じ長さの期間）", () => {
  const v1: VersionInfo = { ...V1, valid_from: "2026-11-01", valid_to: "2026-11-15" };
  const v2: VersionInfo = { ...V1, id: "v2", version_no: 2, valid_from: "2026-11-15", valid_to: "2026-11-15" }; // 適用前に変更
  const v3: VersionInfo = { ...V1, id: "v3", version_no: 3, valid_from: "2026-11-15", valid_to: null, start_time: "07:30:00" };
  const rows = [
    ...doneOn(days(14, "2026-11-01"), 10, { routine_version_id: "v1" }),
    ...doneOn(days(5, "2026-11-15"), 0, { routine_version_id: "v3", start_source: "planned" }),
  ];

  it("前の版の最後の N 日と、後の版の最初の N 日（N は短いほう）。一度も有効にならなかった版は飛ばす", () => {
    const c = compareVersions(rows, [v1, v2, v3], "v1", "v3", "2026-11-19")!;
    expect(c.days).toBe(5);
    expect([c.before.from, c.before.to, c.after.from, c.after.to]).toEqual(["2026-11-10", "2026-11-14", "2026-11-15", "2026-11-19"]);
    expect(c.before.stats.rate).toMatchObject({ num: 5, den: 5 });
    expect(c.warnings).toEqual([
      "比べられる期間が 5 日だけです（目安は 28 日）。",
      "「予定どおり」で記録した完了（遅れは入力上の0分）を、変更前 0 件・変更後 5 件含みます。",
    ]);
    expect(compareWithPrevious(rows, [v1, v2, v3], "v3", "2026-11-19")!.before.version.id).toBe("v1");
  });

  it("順番が逆・同じ版・まだ1日も経っていない版は比べない（データ不足）", () => {
    expect(compareVersions(rows, [v1, v3], "v3", "v1", "2026-11-19")).toBeNull();
    expect(compareVersions(rows, [v1, v3], "v1", "v1", "2026-11-19")).toBeNull();
    expect(compareVersions(rows, [v1, { ...v3, valid_from: "2026-11-20" }], "v1", "v3", "2026-11-19")).toBeNull();
  });

  it("5 件未満は参考値の注意。見送り・未実施の理由の内訳と翌日以降の割合も出す", () => {
    const r = [
      fact({ date: "2026-11-13", routine_version_id: "v1", status: "skipped", closing_reason_code: "no_time" }),
      fact({ date: "2026-11-14", routine_version_id: "v1", status: "missed" }),
      fact({ date: "2026-11-15", routine_version_id: "v3", delay: 1500, is_late_day: true }),
    ];
    const c = compareVersions(r, [v1, v3], "v1", "v3", "2026-11-16")!;
    expect(c.before.stats.reasons).toMatchObject({ no_time: 1, none: 1 });
    expect(c.after.stats.lateDay).toMatchObject({ num: 1, den: 1 });
    expect(c.warnings).toContain("変更前の確定した予定が 2 件だけです（5件未満は参考値）。");
  });
});

describe("書き出し", () => {
  it("CSV の値：, \" 改行は引用符で囲み、式として扱われる先頭文字には ' を付ける", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("1行目\n2行目")).toBe('"1行目\n2行目"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [[1, "x"]])).toBe("﻿a,b\r\n1,x\r\n");
  });

  it("予定と実績の CSV：予定1回＝1行、JST と UTC の両方の時刻", () => {
    const csv = factsCsv([fact({ date: "2026-11-10", delay: 5, routine_id: "r1" })], new Map([["r1", "朝, ストレッチ"]]));
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('2026-11-10,火,"朝, ストレッチ",1,2026-11-10 07:00,15,完了,0,2026-11-10 07:05,15,2026-11-10,いいえ,今終わった,5,,2026-11-09T22:00:00.000Z');
  });

  it("JSON：決めた表だけを入れ、端末の情報は含めない旨を書く。ファイル名は JST の日付", () => {
    const data = Object.fromEntries(EXPORT_TABLES.map((t) => [t, []])) as unknown as ExportData;
    const json = JSON.parse(buildJson({ ...data, routines: [{ id: "r1" }] }, new Date("2026-11-30T15:30:00Z")));
    expect(Object.keys(json.tables)).toEqual([...EXPORT_TABLES]);
    expect(json.tables.routines).toEqual([{ id: "r1" }]);
    expect(Object.keys(json.tables)).not.toContain("push_subscriptions");
    expect(json.excluded).toContain("端末");
    expect(exportFileName(new Date("2026-11-30T15:30:00Z"), "csv")).toBe("routine-lab-20261201.csv");
  });
});
