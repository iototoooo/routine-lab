// 延期の再通知時刻（要件 F-403）。DB の _postpone と同じ計算（tests/unit/postpone.test.ts）。
//   10m / 30m / 1h：今（分に切り捨て）から
//   today_at：今日（JST）の指定時刻
//   tomorrow_same：明日（JST）の、予定と同じ時刻
// 有効なのは「今より後」かつ「期限（予定日の翌日の終わり）より前」のときだけ。

import {
  addDays,
  jstDate,
  jstDateTimeToInstant,
  jstTime,
  occurrenceDeadline,
  truncateToMinute,
} from "@/lib/time/jst";

export const POSTPONE_OPTIONS = ["10m", "30m", "1h", "today_at", "tomorrow_same"] as const;
export type PostponeOption = (typeof POSTPONE_OPTIONS)[number];

export const POSTPONE_LABEL: Record<PostponeOption, string> = {
  "10m": "10分後",
  "30m": "30分後",
  "1h": "1時間後",
  today_at: "今日の指定時刻",
  tomorrow_same: "明日の同じ時刻",
};

type Occ = { planned_date: string; planned_start_at: string | Date };

/** 選択肢から再通知の時刻を求める（today_at は todayTime "HH:MM" が必要）。求められなければ null */
export function remindAtFor(option: PostponeOption, now: Date, occ: Occ, todayTime?: string): Date | null {
  const base = truncateToMinute(now);
  switch (option) {
    case "10m":
      return new Date(base.getTime() + 10 * 60000);
    case "30m":
      return new Date(base.getTime() + 30 * 60000);
    case "1h":
      return new Date(base.getTime() + 60 * 60000);
    case "tomorrow_same":
      return jstDateTimeToInstant(addDays(jstDate(now), 1), jstTime(new Date(occ.planned_start_at)));
    case "today_at":
      if (!todayTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(todayTime)) return null;
      return jstDateTimeToInstant(jstDate(now), todayTime);
  }
}

/** その時刻で延期できるか（今より後・期限より前） */
export function isValidRemindAt(remindAt: Date | null, now: Date, plannedDate: string): remindAt is Date {
  return (
    remindAt !== null &&
    remindAt.getTime() > now.getTime() &&
    remindAt.getTime() < occurrenceDeadline(plannedDate).getTime()
  );
}

/** 画面に出す選択肢（today_at は時刻の入力しだいなので、期限が今日中にあるかだけで判断） */
export function availablePostponeOptions(now: Date, occ: Occ): PostponeOption[] {
  return POSTPONE_OPTIONS.filter((opt) => {
    if (opt === "today_at") {
      // 今日の残り時間が1分以上あり、かつ期限の前に今日が終わる or 期限が今日の中にある
      const endOfToday = jstDateTimeToInstant(addDays(jstDate(now), 1), "00:00");
      const limit = Math.min(endOfToday.getTime(), occurrenceDeadline(occ.planned_date).getTime());
      return limit - truncateToMinute(now).getTime() > 60000;
    }
    return isValidRemindAt(remindAtFor(opt, now, occ), now, occ.planned_date);
  });
}
