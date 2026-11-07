// ルーティンの設定（要件 F-101・F-102）の入力チェックと、版どうしの差分。
// DB の制約・RPC（_create_routine / _edit_routine）と同じ規則にする。画面のチェックは補助で、本当の守りは DB。

import { isFiveMinuteTime, weekdayShort } from "@/lib/time/jst";

export type RoutineSettings = {
  name: string;
  note: string;
  weekdays: number[]; // ISO 1=月 … 7=日
  startTime: string; // "HH:MM"（5分単位）
  durationMin: number; // 5〜480
  snoozeMin: number; // 5〜240
};

export const NAME_MAX = 40;
export const NOTE_MAX = 500;
export const REASON_MAX = 200;
export const DURATION_MIN = 5;
export const DURATION_MAX = 480;
export const SNOOZE_CHOICES = [5, 10, 15, 30, 60] as const;

export type RoutineErrors = Partial<Record<keyof RoutineSettings, string>>;

/** 昇順・重複なし・1〜7 だけにする */
export function normalizeWeekdays(days: number[]): number[] {
  return [...new Set(days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
}

export function validateRoutine(s: RoutineSettings): RoutineErrors {
  const e: RoutineErrors = {};
  const name = s.name.trim();
  if (name.length === 0) e.name = "名前を入力してください";
  else if (name.length > NAME_MAX) e.name = `名前は${NAME_MAX}文字以内にしてください`;
  if (s.note.trim().length > NOTE_MAX) e.note = `メモは${NOTE_MAX}文字以内にしてください`;
  if (normalizeWeekdays(s.weekdays).length === 0) e.weekdays = "曜日を1つ以上選んでください";
  if (!isFiveMinuteTime(s.startTime)) e.startTime = "開始時刻は5分単位で選んでください";
  if (!Number.isInteger(s.durationMin) || s.durationMin < DURATION_MIN || s.durationMin > DURATION_MAX) {
    e.durationMin = `所要時間は${DURATION_MIN}〜${DURATION_MAX}分にしてください`;
  }
  if (!Number.isInteger(s.snoozeMin) || s.snoozeMin < 5 || s.snoozeMin > 240) {
    e.snoozeMin = "再通知は5〜240分にしてください";
  }
  return e;
}

/** 曜日の表示（毎日・平日・土日、それ以外は「月・水・金」） */
export function formatWeekdays(days: number[]): string {
  const d = normalizeWeekdays(days);
  if (d.length === 7) return "毎日";
  if (d.join() === "1,2,3,4,5") return "平日";
  if (d.join() === "6,7") return "土日";
  return d.map(weekdayShort).join("・");
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

export type SettingsChange = { label: string; before: string; after: string };

/** 変更前と変更後の違い（編集の確認画面・版の履歴で使う） */
export function diffSettings(before: RoutineSettings, after: RoutineSettings): SettingsChange[] {
  const rows: [string, string, string][] = [
    ["名前", before.name.trim(), after.name.trim()],
    ["メモ", before.note.trim() || "（なし）", after.note.trim() || "（なし）"],
    ["曜日", formatWeekdays(before.weekdays), formatWeekdays(after.weekdays)],
    ["開始時刻", before.startTime, after.startTime],
    ["所要時間", formatDuration(before.durationMin), formatDuration(after.durationMin)],
    ["再通知", `${before.snoozeMin}分後`, `${after.snoozeMin}分後`],
  ];
  return rows.filter(([, b, a]) => b !== a).map(([label, b, a]) => ({ label, before: b, after: a }));
}

/** 適用開始日のチェック（今日以降・今の版の開始日以降・1年以内。DB の invalid_valid_from と同じ） */
export function validateValidFrom(validFrom: string, today: string, currentValidFrom: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) return "適用開始日を選んでください";
  if (validFrom < today) return "適用開始日は今日以降にしてください";
  if (validFrom < currentValidFrom) return `適用開始日は ${currentValidFrom} 以降にしてください（今の設定の開始日）`;
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + 365);
  if (validFrom > limit.toISOString().slice(0, 10)) return "適用開始日は1年以内にしてください";
  return null;
}
