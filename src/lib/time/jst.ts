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
