// 時間帯の分類（要件 F-505。予定開始時刻の JST で分類する）。
// DB のビュー occurrence_facts.time_band と同じ定義（tests/db/phase1-records.test.ts で一致を確認）。

export const TIME_BANDS = ["early", "morning", "midday", "afternoon", "evening", "night"] as const;
export type TimeBand = (typeof TIME_BANDS)[number];

export const TIME_BAND_LABEL: Record<TimeBand, string> = {
  early: "早朝（4〜7時）",
  morning: "朝（7〜10時）",
  midday: "昼（10〜14時）",
  afternoon: "午後（14〜18時）",
  evening: "夜（18〜22時）",
  night: "深夜（22〜4時）",
};

/** "HH:MM"（JST）→ 時間帯 */
export function timeBand(hhmm: string): TimeBand {
  const m = /^([01]\d|2[0-3]):[0-5]\d$/.exec(hhmm);
  if (!m) throw new Error(`時刻の形式が不正です: ${hhmm}`);
  const h = Number(m[1]);
  if (h >= 4 && h < 7) return "early";
  if (h >= 7 && h < 10) return "morning";
  if (h >= 10 && h < 14) return "midday";
  if (h >= 14 && h < 18) return "afternoon";
  if (h >= 18 && h < 22) return "evening";
  return "night";
}
