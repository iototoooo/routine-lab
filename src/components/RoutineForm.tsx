"use client";

import type { RoutineErrors, RoutineSettings } from "@/lib/domain/routine";
import { DURATION_MAX, DURATION_MIN, NAME_MAX, NOTE_MAX, SNOOZE_CHOICES } from "@/lib/domain/routine";
import { weekdayShort } from "@/lib/time/jst";
import { inputBase } from "@/components/ui";

// ルーティンの設定の入力欄（F-101）。開始時刻は5分単位にするため、時と分を別々に選ぶ
// （iPhone の時刻入力は step を無視するので、type="time" では 5 分単位を守れない）。

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-sm text-danger">
      {message}
    </p>
  );
}

export function RoutineForm({
  value,
  onChange,
  errors,
}: {
  value: RoutineSettings;
  onChange: (v: RoutineSettings) => void;
  errors: RoutineErrors;
}) {
  const set = <K extends keyof RoutineSettings>(k: K, v: RoutineSettings[K]) => onChange({ ...value, [k]: v });
  const [h, m] = value.startTime.split(":");
  const toggleDay = (d: number) =>
    set("weekdays", value.weekdays.includes(d) ? value.weekdays.filter((x) => x !== d) : [...value.weekdays, d]);

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-bold">名前（{NAME_MAX}文字まで）</span>
        <input
          className={inputBase}
          value={value.name}
          maxLength={NAME_MAX + 10}
          onChange={(e) => set("name", e.target.value)}
          aria-invalid={!!errors.name}
          aria-describedby="err-name"
          placeholder="例：朝のストレッチ"
        />
        <FieldError id="err-name" message={errors.name} />
      </label>

      <fieldset>
        <legend className="text-sm font-bold">曜日</legend>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => {
            const on = value.weekdays.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                aria-label={`${weekdayShort(d)}曜日`}
                onClick={() => toggleDay(d)}
                className={`min-h-11 rounded-md border font-bold ${
                  on ? "border-accent bg-accent text-accent-foreground" : "border-border bg-surface"
                }`}
              >
                {weekdayShort(d)}
              </button>
            );
          })}
        </div>
        <FieldError id="err-weekdays" message={errors.weekdays} />
      </fieldset>

      <fieldset>
        <legend className="text-sm font-bold">開始時刻</legend>
        <div className="mt-1 flex items-center gap-2">
          <select
            aria-label="時"
            className={`${inputBase} mt-0 w-24`}
            value={h}
            onChange={(e) => set("startTime", `${e.target.value}:${m}`)}
          >
            {HOURS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <span>:</span>
          <select
            aria-label="分"
            className={`${inputBase} mt-0 w-24`}
            value={m}
            onChange={(e) => set("startTime", `${h}:${e.target.value}`)}
          >
            {MINUTES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </div>
        <FieldError id="err-start" message={errors.startTime} />
      </fieldset>

      <label className="block">
        <span className="text-sm font-bold">
          予定の所要時間（分、{DURATION_MIN}〜{DURATION_MAX}）
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={DURATION_MIN}
          max={DURATION_MAX}
          className={inputBase}
          value={Number.isFinite(value.durationMin) ? value.durationMin : ""}
          onChange={(e) => set("durationMin", e.target.value === "" ? Number.NaN : Number(e.target.value))}
          aria-invalid={!!errors.durationMin}
        />
        <FieldError id="err-duration" message={errors.durationMin} />
      </label>

      <label className="block">
        <span className="text-sm font-bold">延期したときの再通知（既定）</span>
        <select className={inputBase} value={value.snoozeMin} onChange={(e) => set("snoozeMin", Number(e.target.value))}>
          {SNOOZE_CHOICES.map((x) => (
            <option key={x} value={x}>
              {x}分後
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm font-bold">メモ（任意、{NOTE_MAX}文字まで）</span>
        <textarea
          className={`${inputBase} py-2`}
          rows={2}
          maxLength={NOTE_MAX}
          value={value.note}
          onChange={(e) => set("note", e.target.value)}
        />
        <FieldError id="err-note" message={errors.note} />
      </label>
    </div>
  );
}
