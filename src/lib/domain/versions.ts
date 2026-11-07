// 版（routine_versions）の扱い（要件 F-102・F-105）。有効期間は [valid_from, valid_to)。
import type { RoutineSettings } from "@/lib/domain/routine";

type V = {
  version_no: number;
  name: string;
  note: string | null;
  weekdays: number[];
  start_time: string;
  duration_min: number;
  snooze_min: number;
  valid_from: string;
  valid_to: string | null;
};

/** "07:00:00" → "07:00" */
export function hhmm(time: string): string {
  return time.slice(0, 5);
}

/** その日に有効な版（なければ null） */
export function versionOn<T extends V>(versions: T[], date: string): T | null {
  return versions.find((v) => v.valid_from <= date && (v.valid_to === null || date < v.valid_to)) ?? null;
}

/** 最新の版（valid_to が null。編集はこの版の後に追加する） */
export function latestVersion<T extends V>(versions: T[]): T | null {
  return [...versions].sort((a, b) => b.version_no - a.version_no)[0] ?? null;
}

/** 一度も有効にならなかった版（同じ日に2回以上編集したとき） */
export function neverEffective(v: V): boolean {
  return v.valid_to !== null && v.valid_to === v.valid_from;
}

export function toSettings(v: V): RoutineSettings {
  return {
    name: v.name,
    note: v.note ?? "",
    weekdays: v.weekdays,
    startTime: hhmm(v.start_time),
    durationMin: v.duration_min,
    snoozeMin: v.snooze_min,
  };
}

/** 有効期間の表示（valid_to は含まないので、終わりの日は前日） */
export function periodLabel(v: V, prevDay: (d: string) => string): string {
  if (neverEffective(v)) return `${v.valid_from}（適用前に変更）`;
  if (v.valid_to === null) return `${v.valid_from} 〜`;
  return `${v.valid_from} 〜 ${prevDay(v.valid_to)}`;
}
