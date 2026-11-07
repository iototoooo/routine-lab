"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { delayLabel } from "@/components/OccurrenceCard";
import { ErrorBox, Loading, StatusBadge, btnPrimary, btnSecondary, card, inputBase, useNow } from "@/components/ui";
import { getOccurrence, postpone, recordDone, skipOccurrence, type OccurrenceDetail } from "@/lib/data/api";
import { errorMessage } from "@/lib/data/errors";
import type { OccurrenceEvent } from "@/lib/data/types";
import {
  POSTPONE_LABEL,
  availablePostponeOptions,
  isValidRemindAt,
  remindAtFor,
  type PostponeOption,
} from "@/lib/domain/postpone";
import { REASON_CODES, REASON_LABEL, REASON_TEXT_MAX, type ReasonCode } from "@/lib/domain/reasons";
import { START_SOURCE_LABEL, computeDoneInput, type StartSource } from "@/lib/domain/record";
import { formatDuration } from "@/lib/domain/routine";
import { canRecord } from "@/lib/domain/status";
import { addDays, formatDateShort, jstDate, jstTime, occurrenceDeadline } from "@/lib/time/jst";

// S-03 記録（F-401〜404）。通知のタップで開く（/record/?o=<予定ID>）。
// 通知から3タップ以内（NF-01）：開く → 「完了を記録」（既定の内容のまま）で終わる。
// ID はクエリ文字列で受け取る（静的出力のため。要件 7.2 節）。

export default function RecordPage() {
  return (
    <AppShell title="記録" back={{ href: "/", label: "今日" }}>
      <AuthGate>
        {() => (
          <Suspense fallback={<Loading />}>
            <RecordBody />
          </Suspense>
        )}
      </AuthGate>
    </AppShell>
  );
}

function RecordBody() {
  const params = useSearchParams();
  const id = params.get("o") ?? "";
  // Phase 0 のテスト通知（予定に結びつかない）
  if (id.startsWith("test-")) {
    return (
      <p className={card}>
        テスト通知から開きました。通知のタップで記録画面が開くことを確認できました。
      </p>
    );
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <ErrorBox message="予定が指定されていません。" />;
  return <OccurrenceRecord id={id} />;
}

type Tab = "done" | "postpone" | "skip";

function OccurrenceRecord({ id }: { id: string }) {
  const router = useRouter();
  const now = useNow(15000);
  const [detail, setDetail] = useState<OccurrenceDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("done");

  const load = useCallback(async () => {
    try {
      setDetail(await getOccurrence(id));
    } catch (e) {
      setError(errorMessage(e));
      setDetail(null);
    }
  }, [id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (detail === undefined) return <Loading />;
  if (detail === null) return <ErrorBox message={error ?? "この予定は見つかりませんでした。"} />;

  const o = detail.occurrence;
  const plannedStart = new Date(o.planned_start_at);
  const recordable = canRecord(o, now);
  const done = () => router.replace("/");

  return (
    <div className="space-y-4">
      <div className={card}>
        <div className="flex items-start justify-between gap-2">
          <p className="break-words text-lg font-bold">{o.routine_name}</p>
          <StatusBadge status={o.status} />
        </div>
        <p className="mt-1 text-muted">
          {formatDateShort(o.planned_date)} {jstTime(plannedStart)} から {formatDuration(o.planned_duration_min)}
        </p>
        {recordable && (
          <p className="mt-1 text-sm text-muted">
            記録の期限：{formatDateShort(addDays(o.planned_date, 1))} の終わりまで
          </p>
        )}
      </div>

      {recordable ? (
        <>
          <div role="tablist" aria-label="記録の種類" className="grid grid-cols-3 gap-2">
            {(["done", "postpone", "skip"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`min-h-11 rounded-md border font-bold ${
                  tab === t ? "border-accent bg-accent text-accent-foreground" : "border-border bg-surface"
                }`}
              >
                {t === "done" ? "完了" : t === "postpone" ? "延期" : "見送り"}
              </button>
            ))}
          </div>
          {tab === "done" && <DonePanel detail={detail} now={now} onDone={done} />}
          {tab === "postpone" && <PostponePanel detail={detail} now={now} onDone={done} />}
          {tab === "skip" && <SkipPanel detail={detail} onDone={done} />}
        </>
      ) : (
        <ClosedSummary detail={detail} now={now} />
      )}

      <EventList events={detail.events} />
    </div>
  );
}

// ---------------------------------------------------------------- 完了
const TIMER_KEY = (id: string) => `routine-lab:timer:${id}`;
function readTimer(id: string): Date | null {
  try {
    const v = localStorage.getItem(TIMER_KEY(id));
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}
function writeTimer(id: string, d: Date | null) {
  try {
    if (d) localStorage.setItem(TIMER_KEY(id), d.toISOString());
    else localStorage.removeItem(TIMER_KEY(id));
  } catch {
    // 保存できなくても、この画面を開いている間は動く
  }
}

function DonePanel({ detail, now, onDone }: { detail: OccurrenceDetail; now: Date; onDone: () => void }) {
  const o = detail.occurrence;
  const plannedStart = new Date(o.planned_start_at);
  const [timerStartedAt, setTimerStartedAt] = useState<Date | null>(() => readTimer(o.id));
  const [source, setSource] = useState<StartSource>(() =>
    readTimer(o.id) ? "timer" : plannedStart.getTime() <= Date.now() ? "planned" : "now",
  );
  const [duration, setDuration] = useState(String(o.planned_duration_min));
  const [manualDate, setManualDate] = useState(() => (jstDate(new Date()) > o.planned_date ? jstDate(new Date()) : o.planned_date));
  const [manualTime, setManualTime] = useState(() => jstTime(plannedStart));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input = computeDoneInput(source, {
    now,
    plannedDate: o.planned_date,
    plannedStartAt: plannedStart,
    durationMin: Number(duration),
    manualDate,
    manualTime,
    timerStartedAt: timerStartedAt ?? undefined,
  });
  const dates = [o.planned_date, addDays(o.planned_date, 1)].filter((d) => d <= jstDate(now));

  async function submit() {
    const fresh = computeDoneInput(source, {
      now: new Date(),
      plannedDate: o.planned_date,
      plannedStartAt: plannedStart,
      durationMin: Number(duration),
      manualDate,
      manualTime,
      timerStartedAt: timerStartedAt ?? undefined,
    });
    if (!fresh.ok) return setError(fresh.error);
    setBusy(true);
    setError(null);
    try {
      await recordDone(o.id, fresh.actualStartAt, fresh.durationMin, fresh.startSource);
      writeTimer(o.id, null);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className={`${card} space-y-4`}>
      <fieldset className="space-y-2">
        <legend className="text-sm font-bold">いつ始めましたか</legend>
        {(["planned", "now", "manual", "timer"] as const).map((s) => (
          <label key={s} className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3">
            <input type="radio" name="start" value={s} checked={source === s} onChange={() => setSource(s)} className="size-5" />
            <span>
              {START_SOURCE_LABEL[s]}
              {s === "planned" && <span className="text-sm text-muted">（{jstTime(plannedStart)}）</span>}
              {s === "now" && <span className="text-sm text-muted">（開始＝今−所要時間）</span>}
            </span>
          </label>
        ))}
      </fieldset>

      {source === "manual" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-sm font-bold">日付</span>
            <select className={inputBase} value={manualDate} onChange={(e) => setManualDate(e.target.value)}>
              {dates.map((d) => (
                <option key={d} value={d}>
                  {formatDateShort(d)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-bold">開始時刻</span>
            <input type="time" className={inputBase} value={manualTime} onChange={(e) => setManualTime(e.target.value)} />
          </label>
        </div>
      )}

      {source === "timer" ? (
        <div className="space-y-2">
          {timerStartedAt ? (
            <>
              <p>
                {jstTime(timerStartedAt)} から計測中（
                {Math.max(0, Math.round((now.getTime() - timerStartedAt.getTime()) / 60000))}分）
              </p>
              <button
                type="button"
                className={btnSecondary}
                onClick={() => {
                  writeTimer(o.id, null);
                  setTimerStartedAt(null);
                }}
              >
                計測をやめる
              </button>
            </>
          ) : (
            <button
              type="button"
              className={btnSecondary}
              onClick={() => {
                const t = new Date();
                writeTimer(o.id, t);
                setTimerStartedAt(t);
              }}
            >
              タイマーを開始
            </button>
          )}
        </div>
      ) : (
        <label className="block">
          <span className="text-sm font-bold">実際の所要時間（分）</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={1440}
            className={inputBase}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </label>
      )}

      {input.ok && (
        <p className="text-sm text-muted">
          記録する内容：{formatDateShort(jstDate(input.actualStartAt))} {jstTime(input.actualStartAt)} 開始・
          {formatDuration(input.durationMin)}（{delayLabel(o.planned_start_at, input.actualStartAt.toISOString())}）
        </p>
      )}
      <ErrorBox message={error ?? (!input.ok && (source !== "timer" || timerStartedAt) ? input.error : null)} />
      <button type="button" className={`${btnPrimary} w-full`} disabled={busy || !input.ok} onClick={submit}>
        {busy ? "保存中…" : source === "timer" && timerStartedAt ? "止めて完了を記録" : "完了を記録"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- 延期
function ReasonPicker({
  value,
  onChange,
  text,
  onText,
  required,
}: {
  value: ReasonCode | null;
  onChange: (v: ReasonCode | null) => void;
  text: string;
  onText: (v: string) => void;
  required: boolean;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-bold">理由{required ? "（必須）" : "（任意）"}</legend>
      <div className="flex flex-wrap gap-2">
        {REASON_CODES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={value === c}
            onClick={() => onChange(value === c ? null : c)}
            className={`min-h-11 rounded-full border px-3 text-sm ${
              value === c ? "border-accent bg-accent font-bold text-accent-foreground" : "border-border bg-surface"
            }`}
          >
            {REASON_LABEL[c]}
          </button>
        ))}
      </div>
      {value && (
        <label className="block">
          <span className="text-sm text-muted">ひとこと（任意）</span>
          <textarea
            className={`${inputBase} py-2`}
            rows={2}
            maxLength={REASON_TEXT_MAX}
            value={text}
            onChange={(e) => onText(e.target.value)}
          />
        </label>
      )}
    </fieldset>
  );
}

function PostponePanel({ detail, now, onDone }: { detail: OccurrenceDetail; now: Date; onDone: () => void }) {
  const o = detail.occurrence;
  const options = availablePostponeOptions(now, o);
  const [option, setOption] = useState<PostponeOption | null>(null);
  const [todayTime, setTodayTime] = useState("");
  const [reason, setReason] = useState<ReasonCode | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remindAt = option ? remindAtFor(option, now, o, todayTime) : null;
  const valid = isValidRemindAt(remindAt, now, o.planned_date);

  async function submit() {
    if (!option) return;
    const fresh = remindAtFor(option, new Date(), o, todayTime);
    if (!isValidRemindAt(fresh, new Date(), o.planned_date)) return setError("再通知の時刻を選び直してください。");
    setBusy(true);
    setError(null);
    try {
      await postpone(o.id, option, fresh, reason, text);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  if (options.length === 0) {
    return <p className={card}>記録の期限が近いため、延期できません。完了か見送りを記録してください。</p>;
  }

  return (
    <div className={`${card} space-y-4`}>
      <fieldset className="space-y-2">
        <legend className="text-sm font-bold">いつもう一度知らせますか</legend>
        <div className="grid grid-cols-2 gap-2">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              aria-pressed={option === opt}
              onClick={() => setOption(opt)}
              className={`min-h-11 rounded-md border px-2 ${
                option === opt ? "border-accent bg-accent font-bold text-accent-foreground" : "border-border bg-surface"
              }`}
            >
              {POSTPONE_LABEL[opt]}
            </button>
          ))}
        </div>
      </fieldset>
      {option === "today_at" && (
        <label className="block">
          <span className="text-sm font-bold">時刻（今日）</span>
          <input type="time" className={inputBase} value={todayTime} onChange={(e) => setTodayTime(e.target.value)} />
        </label>
      )}
      {option && (
        <p className="text-sm text-muted">
          {valid && remindAt
            ? `再通知：${formatDateShort(jstDate(remindAt))} ${jstTime(remindAt)}（予定時刻は ${jstTime(new Date(o.planned_start_at))} のまま記録します）`
            : `期限（${formatDateShort(addDays(o.planned_date, 1))} の終わり、${jstTime(occurrenceDeadline(o.planned_date))}）より前の、今より後の時刻にしてください`}
        </p>
      )}
      <p className="text-sm text-muted">通知での再通知は Phase 2 で有効になります。今は時刻と理由を記録します。</p>
      <ReasonPicker value={reason} onChange={setReason} text={text} onText={setText} required={false} />
      <ErrorBox message={error} />
      <button type="button" className={`${btnPrimary} w-full`} disabled={busy || !valid} onClick={submit}>
        {busy ? "保存中…" : "延期する"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- 見送り
function SkipPanel({ detail, onDone }: { detail: OccurrenceDetail; onDone: () => void }) {
  const o = detail.occurrence;
  const [reason, setReason] = useState<ReasonCode | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reason) return setError("見送りの理由を選んでください。");
    setBusy(true);
    setError(null);
    try {
      await skipOccurrence(o.id, reason, text);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className={`${card} space-y-4`}>
      <ReasonPicker value={reason} onChange={setReason} text={text} onText={setText} required />
      <ErrorBox message={error} />
      <button type="button" className={`${btnPrimary} w-full`} disabled={busy || !reason} onClick={submit}>
        {busy ? "保存中…" : "今回は見送る"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- 確定済み・履歴
function ClosedSummary({ detail, now }: { detail: OccurrenceDetail; now: Date }) {
  const o = detail.occurrence;
  const e = o.execution;
  return (
    <div className={`${card} space-y-1`}>
      {e ? (
        <>
          <p className="font-bold">完了を記録しました</p>
          <p>
            {formatDateShort(e.executed_date)} {jstTime(new Date(e.actual_start_at))} 開始・{formatDuration(e.actual_duration_min)}
          </p>
          <p className="text-sm text-muted">
            予定との差：{delayLabel(o.planned_start_at, e.actual_start_at)}
            {e.is_late_day ? "・予定日の翌日以降に実施" : ""}
          </p>
        </>
      ) : o.status === "scheduled" || o.status === "notified" || o.status === "postponed" ? (
        <p>
          記録の期限（{jstTime(occurrenceDeadline(o.planned_date))}）を過ぎました。
          {now.getTime() >= occurrenceDeadline(o.planned_date).getTime() ? "まもなく未実施になります。" : ""}
        </p>
      ) : (
        <p>この予定は確定しています。</p>
      )}
    </div>
  );
}

const EVENT_LABEL: Record<OccurrenceEvent["type"], string> = {
  done: "完了",
  postponed: "延期",
  skipped: "見送り",
  missed: "未実施（期限切れ）",
  edited: "設定の変更に合わせて更新",
  cancelled: "取り消し",
  notified: "通知",
};

function EventList({ events }: { events: OccurrenceEvent[] }) {
  if (events.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="font-bold">この予定の記録</h2>
      <ol className="space-y-1 text-sm">
        {events.map((ev) => (
          <li key={ev.id} className="rounded-md border border-border bg-surface px-3 py-2">
            <span className="text-muted">
              {formatDateShort(jstDate(new Date(ev.created_at)))} {jstTime(new Date(ev.created_at))}
            </span>{" "}
            <span className="font-bold">{EVENT_LABEL[ev.type]}</span>
            {ev.remind_at && <> → 再通知 {jstTime(new Date(ev.remind_at))}</>}
            {ev.reason_code && <>（{REASON_LABEL[ev.reason_code]}{ev.reason_text ? `：${ev.reason_text}` : ""}）</>}
          </li>
        ))}
      </ol>
    </section>
  );
}
