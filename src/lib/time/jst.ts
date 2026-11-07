// 日本時間（Asia/Tokyo）の日付・曜日の計算（P-05、docs/plan.md 3章）。
// 日本にはサマータイムがないため、常に UTC+9 として扱う。
// 日付は "YYYY-MM-DD" の文字列、時刻の瞬間は Date（UTC）で表す。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseDate(date: string): { y: number; m: number; d: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`日付の形式が不正です: ${date}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new Error(`存在しない日付です: ${date}`);
  }
  return { y, m: mo, d };
}

/** ある瞬間の JST の日付 "YYYY-MM-DD" */
export function jstDate(instant: Date): string {
  const t = new Date(instant.getTime() + JST_OFFSET_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** ある瞬間の JST の時刻 "HH:MM" */
export function jstTime(instant: Date): string {
  const t = new Date(instant.getTime() + JST_OFFSET_MS);
  return `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
}

/** ISO 曜日（1=月 … 7=日） */
export function isoWeekday(date: string): number {
  const { y, m, d } = parseDate(date);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=日
  return w === 0 ? 7 : w;
}

/** 日付に n 日を足す */
export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDate(date);
  return jstDate(new Date(Date.UTC(y, m - 1, d) - JST_OFFSET_MS + n * DAY_MS));
}

/** JST の日付と "HH:MM" から、その瞬間（UTC）を求める */
export function jstDateTimeToInstant(date: string, time: string): Date {
  const { y, m, d } = parseDate(date);
  const t = TIME_RE.exec(time);
  if (!t) throw new Error(`時刻の形式が不正です: ${time}`);
  return new Date(Date.UTC(y, m - 1, d, Number(t[1]), Number(t[2])) - JST_OFFSET_MS);
}

/** JST の今日と明日（予定の作成対象、F-201） */
export function todayAndTomorrow(now: Date): [string, string] {
  const today = jstDate(now);
  return [today, addDays(today, 1)];
}

/** 記録の期限：予定日の翌日の終わり（＝予定日＋2日の 0:00 JST。F-406。DB の occurrence_deadline と同じ） */
export function occurrenceDeadline(plannedDate: string): Date {
  return jstDateTimeToInstant(addDays(plannedDate, 2), "00:00");
}

/** 分に切り捨て */
export function truncateToMinute(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / 60000) * 60000);
}

/** 2つの瞬間の差（分、b − a。四捨五入） */
export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

/** "HH:MM" が 5 分単位か */
export function isFiveMinuteTime(time: string): boolean {
  return TIME_RE.test(time) && Number(time.slice(3)) % 5 === 0;
}

const WEEKDAY_SHORT = ["月", "火", "水", "木", "金", "土", "日"] as const;

/** ISO 曜日（1〜7）の短い表記 */
export function weekdayShort(isoDay: number): string {
  const s = WEEKDAY_SHORT[isoDay - 1];
  if (!s) throw new Error(`曜日が不正です: ${isoDay}`);
  return s;
}

/** "2026-11-10" → "11/10（火）" */
export function formatDateShort(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}（${weekdayShort(isoWeekday(date))}）`;
}
