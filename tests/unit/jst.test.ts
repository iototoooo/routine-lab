import { describe, expect, it } from "vitest";
import {
  addDays,
  isoWeekday,
  jstDate,
  jstDateTimeToInstant,
  jstTime,
  todayAndTomorrow,
} from "@/lib/time/jst";

describe("jstDate / jstTime", () => {
  it("UTC 14:59 は JST 23:59（同じ日）、UTC 15:00 は JST 翌日 0:00", () => {
    expect(jstDate(new Date("2026-11-09T14:59:59Z"))).toBe("2026-11-09");
    expect(jstTime(new Date("2026-11-09T14:59:59Z"))).toBe("23:59");
    expect(jstDate(new Date("2026-11-09T15:00:00Z"))).toBe("2026-11-10");
    expect(jstTime(new Date("2026-11-09T15:00:00Z"))).toBe("00:00");
  });
  it("年末・年始", () => {
    expect(jstDate(new Date("2026-12-31T15:00:00Z"))).toBe("2027-01-01");
    expect(jstDate(new Date("2026-12-31T14:59:00Z"))).toBe("2026-12-31");
  });
});

describe("isoWeekday", () => {
  it("1=月 … 7=日", () => {
    expect(isoWeekday("2026-11-09")).toBe(1); // 月
    expect(isoWeekday("2026-11-10")).toBe(2); // 火
    expect(isoWeekday("2026-11-15")).toBe(7); // 日
  });
  it("存在しない日付・不正な形式は例外", () => {
    expect(() => isoWeekday("2026-02-30")).toThrow();
    expect(() => isoWeekday("2026/11/09")).toThrow();
  });
});

describe("addDays", () => {
  it("日曜→月曜、月末、うるう年", () => {
    expect(addDays("2026-11-15", 1)).toBe("2026-11-16");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });
});

describe("jstDateTimeToInstant", () => {
  it("JST 7:00 は UTC 前日 22:00", () => {
    expect(jstDateTimeToInstant("2026-11-10", "07:00").toISOString()).toBe("2026-11-09T22:00:00.000Z");
  });
  it("23:30 開始の予定は、開始日の日付のまま（0:00 をまたいでも予定日は変わらない）", () => {
    const start = jstDateTimeToInstant("2026-11-10", "23:30");
    expect(jstDate(start)).toBe("2026-11-10");
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    expect(jstDate(end)).toBe("2026-11-11");
  });
  it("不正な時刻は例外", () => {
    expect(() => jstDateTimeToInstant("2026-11-10", "24:00")).toThrow();
    expect(() => jstDateTimeToInstant("2026-11-10", "7:00")).toThrow();
  });
});

describe("todayAndTomorrow", () => {
  it("0:00 JST の直後は、その日と翌日", () => {
    expect(todayAndTomorrow(new Date("2026-11-09T15:00:30Z"))).toEqual(["2026-11-10", "2026-11-11"]);
  });
});
