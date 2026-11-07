import { describe, expect, test } from "vitest";
import {
  formatDateShort,
  isFiveMinuteTime,
  minutesBetween,
  occurrenceDeadline,
  truncateToMinute,
} from "@/lib/time/jst";
import { timeBand } from "@/lib/time/bands";
import { availablePostponeOptions, isValidRemindAt, remindAtFor } from "@/lib/domain/postpone";
import { computeDoneInput } from "@/lib/domain/record";
import {
  diffSettings,
  formatDuration,
  formatWeekdays,
  normalizeWeekdays,
  validateRoutine,
  validateValidFrom,
  type RoutineSettings,
} from "@/lib/domain/routine";
import { canRecord, isOpen } from "@/lib/domain/status";
import { REASON_CODES, isReasonCode } from "@/lib/domain/reasons";

const at = (s: string) => new Date(s);
const TUE = "2026-11-10";
const occ = { planned_date: TUE, planned_start_at: "2026-11-09T22:00:00Z" }; // 火 7:00 JST

describe("jst の追加分", () => {
  test("期限は予定日＋2日の 0:00 JST（翌日の終わり）", () => {
    expect(occurrenceDeadline(TUE).toISOString()).toBe("2026-11-11T15:00:00.000Z");
    expect(occurrenceDeadline("2026-12-31").toISOString()).toBe("2027-01-01T15:00:00.000Z");
  });
  test("分の切り捨て・差・5分単位・表示", () => {
    expect(truncateToMinute(at("2026-11-10T00:00:59.999Z")).toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(minutesBetween(at("2026-11-09T22:00:00Z"), at("2026-11-09T22:35:00Z"))).toBe(35);
    expect(minutesBetween(at("2026-11-09T22:00:00Z"), at("2026-11-09T21:50:00Z"))).toBe(-10);
    expect(isFiveMinuteTime("07:05")).toBe(true);
    expect(isFiveMinuteTime("07:03")).toBe(false);
    expect(isFiveMinuteTime("24:00")).toBe(false);
    expect(formatDateShort(TUE)).toBe("11/10（火）");
    expect(formatDateShort("2026-11-15")).toBe("11/15（日）");
  });
  test("時間帯（F-505）の境界", () => {
    expect(["03:59", "04:00", "06:59", "07:00", "09:59", "10:00", "13:59", "14:00", "17:59", "18:00", "21:59", "22:00", "00:00"].map(timeBand)).toEqual([
      "night", "early", "early", "morning", "morning", "midday", "midday", "afternoon", "afternoon", "evening", "evening", "night", "night",
    ]);
  });
});

describe("延期の時刻（F-403）", () => {
  test("10分・30分・1時間は今（分に切り捨て）から", () => {
    const now = at("2026-11-09T22:02:30Z");
    expect(remindAtFor("10m", now, occ)!.toISOString()).toBe("2026-11-09T22:12:00.000Z");
    expect(remindAtFor("30m", now, occ)!.toISOString()).toBe("2026-11-09T22:32:00.000Z");
    expect(remindAtFor("1h", now, occ)!.toISOString()).toBe("2026-11-09T23:02:00.000Z");
  });
  test("明日の同じ時刻は、明日（JST）の予定の時刻", () => {
    expect(remindAtFor("tomorrow_same", at("2026-11-09T22:05:00Z"), occ)!.toISOString()).toBe("2026-11-10T22:00:00.000Z");
  });
  test("今日の指定時刻（形式が違えば null）", () => {
    expect(remindAtFor("today_at", at("2026-11-09T22:05:00Z"), occ, "21:15")!.toISOString()).toBe("2026-11-10T12:15:00.000Z");
    expect(remindAtFor("today_at", at("2026-11-09T22:05:00Z"), occ, "25:00")).toBeNull();
    expect(remindAtFor("today_at", at("2026-11-09T22:05:00Z"), occ)).toBeNull();
  });
  test("有効なのは今より後・期限より前だけ", () => {
    const now = at("2026-11-11T14:30:00Z"); // 水 23:30 JST（期限は木 0:00）
    expect(isValidRemindAt(remindAtFor("10m", now, occ), now, TUE)).toBe(true);
    expect(isValidRemindAt(remindAtFor("1h", now, occ), now, TUE)).toBe(false);
    expect(isValidRemindAt(at("2026-11-11T14:00:00Z"), now, TUE)).toBe(false);
  });
  test("選択肢：当日はすべて。翌日の夜は「明日の同じ時刻」と「1時間後」が消える", () => {
    expect(availablePostponeOptions(at("2026-11-09T22:05:00Z"), occ)).toEqual(["10m", "30m", "1h", "today_at", "tomorrow_same"]);
    expect(availablePostponeOptions(at("2026-11-11T14:30:00Z"), occ)).toEqual(["10m", "today_at"]);
    // 期限の1分前は何も選べない
    expect(availablePostponeOptions(at("2026-11-11T14:59:00Z"), occ)).toEqual([]);
  });
});

describe("完了の記録（F-402）", () => {
  const base = { plannedDate: TUE, plannedStartAt: at(occ.planned_start_at), durationMin: 15 };
  test("予定どおり：開始＝予定時刻（予定時刻より前は使えない）", () => {
    const r = computeDoneInput("planned", { ...base, now: at("2026-11-09T22:20:00Z") });
    expect(r).toEqual({ ok: true, actualStartAt: base.plannedStartAt, durationMin: 15, startSource: "planned" });
    expect(computeDoneInput("planned", { ...base, now: at("2026-11-09T21:50:00Z") }).ok).toBe(false);
  });
  test("今終わった：開始＝今（分に切り捨て）−所要時間", () => {
    const r = computeDoneInput("now", { ...base, now: at("2026-11-09T22:40:30Z"), durationMin: 20 });
    expect(r.ok && r.actualStartAt.toISOString()).toBe("2026-11-09T22:20:00.000Z");
  });
  test("時刻を指定：翌日でもよい。予定日より前・未来はだめ", () => {
    const now = at("2026-11-10T23:00:00Z"); // 水 8:00 JST
    const ok = computeDoneInput("manual", { ...base, now, manualDate: "2026-11-11", manualTime: "07:30" });
    expect(ok.ok && ok.actualStartAt.toISOString()).toBe("2026-11-10T22:30:00.000Z");
    expect(computeDoneInput("manual", { ...base, now, manualDate: "2026-11-09", manualTime: "23:59" }).ok).toBe(false);
    expect(computeDoneInput("manual", { ...base, now, manualDate: "2026-11-11", manualTime: "09:00" }).ok).toBe(false);
    expect(computeDoneInput("manual", { ...base, now }).ok).toBe(false);
  });
  test("タイマー：所要時間は経過時間（最低1分）", () => {
    const r = computeDoneInput("timer", { ...base, now: at("2026-11-09T22:17:40Z"), timerStartedAt: at("2026-11-09T22:00:10Z") });
    expect(r).toEqual({ ok: true, actualStartAt: at("2026-11-09T22:00:00Z"), durationMin: 18, startSource: "timer" });
    const short = computeDoneInput("timer", { ...base, now: at("2026-11-09T22:00:20Z"), timerStartedAt: at("2026-11-09T22:00:10Z") });
    expect(short.ok && short.durationMin).toBe(1);
  });
  test("所要時間の範囲", () => {
    expect(computeDoneInput("planned", { ...base, now: at("2026-11-10T00:00:00Z"), durationMin: 0 }).ok).toBe(false);
    expect(computeDoneInput("planned", { ...base, now: at("2026-11-10T00:00:00Z"), durationMin: 1441 }).ok).toBe(false);
  });
});

describe("ルーティンの入力（F-101・F-102）", () => {
  const ok: RoutineSettings = { name: "朝のストレッチ", note: "", weekdays: [1, 3, 5], startTime: "07:00", durationMin: 15, snoozeMin: 10 };
  test("正しい入力はエラーなし", () => expect(validateRoutine(ok)).toEqual({}));
  test("各項目の検査", () => {
    expect(Object.keys(validateRoutine({ ...ok, name: " ", weekdays: [], startTime: "07:03", durationMin: 4, snoozeMin: 1 }))).toEqual([
      "name", "weekdays", "startTime", "durationMin", "snoozeMin",
    ]);
    expect(validateRoutine({ ...ok, name: "あ".repeat(41) }).name).toBeTruthy();
    expect(validateRoutine({ ...ok, name: "あ".repeat(40) }).name).toBeUndefined();
    expect(validateRoutine({ ...ok, durationMin: 480 }).durationMin).toBeUndefined();
    expect(validateRoutine({ ...ok, durationMin: 481 }).durationMin).toBeTruthy();
  });
  test("曜日の正規化と表示", () => {
    expect(normalizeWeekdays([5, 1, 5, 8, 0])).toEqual([1, 5]);
    expect(formatWeekdays([1, 2, 3, 4, 5, 6, 7])).toBe("毎日");
    expect(formatWeekdays([5, 4, 3, 2, 1])).toBe("平日");
    expect(formatWeekdays([7, 6])).toBe("土日");
    expect(formatWeekdays([1, 3, 5])).toBe("月・水・金");
    expect(formatDuration(15)).toBe("15分");
    expect(formatDuration(90)).toBe("1時間30分");
    expect(formatDuration(120)).toBe("2時間");
  });
  test("変更前と変更後の差分", () => {
    expect(diffSettings(ok, { ...ok, startTime: "07:30", weekdays: [1, 2, 3, 4, 5] })).toEqual([
      { label: "曜日", before: "月・水・金", after: "平日" },
      { label: "開始時刻", before: "07:00", after: "07:30" },
    ]);
    expect(diffSettings(ok, { ...ok })).toEqual([]);
  });
  test("適用開始日", () => {
    expect(validateValidFrom(TUE, TUE, "2026-11-01")).toBeNull();
    expect(validateValidFrom("2026-11-09", TUE, "2026-11-01")).toMatch(/今日以降/);
    expect(validateValidFrom("2026-11-12", TUE, "2026-11-15")).toMatch(/以降/);
    expect(validateValidFrom("2027-11-11", TUE, TUE)).toMatch(/1年以内/);
    expect(validateValidFrom("", TUE, TUE)).toMatch(/選んで/);
  });
});

describe("状態と理由", () => {
  test("記録できるのは未確定かつ期限前", () => {
    expect(isOpen("postponed")).toBe(true);
    expect(isOpen("done")).toBe(false);
    expect(canRecord({ status: "scheduled", planned_date: TUE }, at("2026-11-11T14:59:59Z"))).toBe(true);
    expect(canRecord({ status: "scheduled", planned_date: TUE }, at("2026-11-11T15:00:00Z"))).toBe(false);
    expect(canRecord({ status: "skipped", planned_date: TUE }, at("2026-11-10T00:00:00Z"))).toBe(false);
  });
  test("理由コード", () => {
    expect(REASON_CODES).toHaveLength(7);
    expect(isReasonCode("tired")).toBe(true);
    expect(isReasonCode("lazy")).toBe(false);
  });
});
