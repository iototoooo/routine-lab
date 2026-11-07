// 完了の記録（要件 F-402）：実際の開始時刻と所要時間の決め方。
// DB の _record_done と同じ規則（開始は予定日の 0:00 JST 以降・今より後でない、所要時間 1〜1440 分）。
//   planned：予定時刻に開始した
//   now    ：今終わった（開始 = 今 − 所要時間。記録はたいてい終わってからするため）
//   manual ：開始時刻を指定した
//   timer  ：タイマーで計った（開始〜停止）

import { jstDateTimeToInstant, truncateToMinute } from "@/lib/time/jst";

export type StartSource = "planned" | "now" | "manual" | "timer";

export const START_SOURCE_LABEL: Record<StartSource, string> = {
  planned: "予定どおりの時刻に始めた",
  now: "今終わった",
  manual: "開始時刻を指定",
  timer: "タイマー",
};

export type DoneInput =
  | { ok: true; actualStartAt: Date; durationMin: number; startSource: StartSource }
  | { ok: false; error: string };

type Args = {
  now: Date;
  plannedDate: string;
  plannedStartAt: Date;
  durationMin: number;
  manualDate?: string; // "YYYY-MM-DD"（JST）
  manualTime?: string; // "HH:MM"
  timerStartedAt?: Date;
};

export function computeDoneInput(source: StartSource, a: Args): DoneInput {
  let start: Date;
  let duration = a.durationMin;
  switch (source) {
    case "planned":
      start = a.plannedStartAt;
      break;
    case "now":
      start = new Date(truncateToMinute(a.now).getTime() - duration * 60000);
      break;
    case "manual":
      if (!a.manualDate || !a.manualTime) return { ok: false, error: "開始時刻を入力してください" };
      start = jstDateTimeToInstant(a.manualDate, a.manualTime);
      break;
    case "timer":
      if (!a.timerStartedAt) return { ok: false, error: "タイマーが動いていません" };
      start = truncateToMinute(a.timerStartedAt);
      duration = Math.max(1, Math.round((a.now.getTime() - a.timerStartedAt.getTime()) / 60000));
      break;
  }
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
    return { ok: false, error: "所要時間は1〜1440分にしてください" };
  }
  if (start.getTime() > a.now.getTime() + 60000) {
    return {
      ok: false,
      error: source === "planned" ? "予定時刻がまだ来ていません。「今終わった」か時刻の指定を選んでください" : "開始時刻が未来になっています",
    };
  }
  if (start.getTime() < jstDateTimeToInstant(a.plannedDate, "00:00").getTime()) {
    return { ok: false, error: "開始時刻は予定日の0:00以降にしてください" };
  }
  return { ok: true, actualStartAt: start, durationMin: duration, startSource: source };
}
