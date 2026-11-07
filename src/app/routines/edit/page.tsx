"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { RoutineForm } from "@/components/RoutineForm";
import { ErrorBox, Loading, btnDanger, btnPrimary, btnSecondary, card, inputBase } from "@/components/ui";
import { archiveRoutine, createRoutine, editRoutine, getRoutine, type RoutineWithVersions } from "@/lib/data/api";
import { errorMessage } from "@/lib/data/errors";
import {
  REASON_MAX,
  diffSettings,
  normalizeWeekdays,
  validateRoutine,
  validateValidFrom,
  type RoutineSettings,
} from "@/lib/domain/routine";
import { latestVersion, toSettings } from "@/lib/domain/versions";
import { formatDateShort, isoWeekday, jstDate, jstDateTimeToInstant } from "@/lib/time/jst";

// S-05 ルーティン編集（F-101〜103）。新規は id なし、編集は ?id=<ID>。
// 編集は新しい版を追加する：適用開始日（既定は今日）と変更理由を入れ、変更前と変更後を確認してから保存する。

export default function RoutineEditPage() {
  return (
    <AppShell title="ルーティン" back={{ href: "/routines/", label: "一覧" }}>
      <AuthGate>
        {() => (
          <Suspense fallback={<Loading />}>
            <EditBody />
          </Suspense>
        )}
      </AuthGate>
    </AppShell>
  );
}

const EMPTY: RoutineSettings = { name: "", note: "", weekdays: [1, 2, 3, 4, 5], startTime: "07:00", durationMin: 15, snoozeMin: 10 };

function EditBody() {
  const id = useSearchParams().get("id");
  const [routine, setRoutine] = useState<RoutineWithVersions | null | undefined>(id ? undefined : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    getRoutine(id)
      .then((r) => setRoutine(r))
      .catch((e) => {
        setError(errorMessage(e));
        setRoutine(null);
      });
  }, [id]);
  if (routine === undefined) return <Loading />;
  if (id && !routine) return <ErrorBox message={error ?? "ルーティンが見つかりませんでした。"} />;
  return routine ? <EditForm routine={routine} /> : <CreateForm />;
}

/** 今日の予定が作られない場合の案内（判断事項1：開始時刻を過ぎてから登録・編集した日は作らない） */
function todayNotice(s: RoutineSettings, validFrom: string): string | null {
  const today = jstDate(new Date());
  if (validFrom !== today || !normalizeWeekdays(s.weekdays).includes(isoWeekday(today))) return null;
  if (jstDateTimeToInstant(today, s.startTime).getTime() > Date.now()) return null;
  return "今日の開始時刻はもう過ぎているため、今日の予定は作られません（次の対象日から作られます）。";
}

function CreateForm() {
  const router = useRouter();
  const [value, setValue] = useState<RoutineSettings>(EMPTY);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = validateRoutine(value);
  const notice = todayNotice(value, jstDate(new Date()));

  async function submit() {
    setShowErrors(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const rid = await createRoutine({ ...value, weekdays: normalizeWeekdays(value.weekdays) });
      router.replace(`/routines/detail/?id=${rid}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">新しいルーティン</h2>
      <RoutineForm value={value} onChange={setValue} errors={showErrors ? errors : {}} />
      {notice && <p className="text-sm text-muted">{notice}</p>}
      <ErrorBox message={error} />
      <button type="button" className={`${btnPrimary} w-full`} disabled={busy} onClick={submit}>
        {busy ? "保存中…" : "登録する"}
      </button>
    </div>
  );
}

function EditForm({ routine }: { routine: RoutineWithVersions }) {
  const router = useRouter();
  const today = jstDate(new Date());
  const latest = latestVersion(routine.versions)!;
  const before = toSettings(latest);
  const [value, setValue] = useState<RoutineSettings>(before);
  const [validFrom, setValidFrom] = useState(latest.valid_from > today ? latest.valid_from : today);
  const [reason, setReason] = useState("");
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiveAsk, setArchiveAsk] = useState(false);

  if (routine.archived_at) {
    return <p className={card}>アーカイブしたルーティンは編集できません。</p>;
  }

  const errors = validateRoutine(value);
  const vfError = validateValidFrom(validFrom, today, latest.valid_from);
  const changes = diffSettings(before, { ...value, weekdays: normalizeWeekdays(value.weekdays) });
  const notice = todayNotice(value, validFrom);

  function toConfirm() {
    setShowErrors(true);
    setError(null);
    if (Object.keys(errors).length > 0 || vfError) return;
    if (changes.length === 0) return setError("変更された項目がありません。");
    setStep("confirm");
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await editRoutine(routine.id, { ...value, weekdays: normalizeWeekdays(value.weekdays) }, validFrom, reason);
      router.replace(`/routines/detail/?id=${routine.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      await archiveRoutine(routine.id);
      router.replace("/routines/");
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  if (step === "confirm") {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-bold">変更内容の確認</h2>
        <div className={card}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 font-normal">項目</th>
                <th className="py-1 font-normal">変更前</th>
                <th className="py-1 font-normal">変更後</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.label} className="border-t border-border align-top">
                  <th className="py-2 pr-2 text-left">{c.label}</th>
                  <td className="py-2 pr-2 break-words">{c.before}</td>
                  <td className="py-2 font-bold break-words">{c.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-sm">
            適用開始日：<span className="font-bold">{formatDateShort(validFrom)}</span>
          </p>
          <p className="text-sm">変更理由：{reason.trim() || "（なし）"}</p>
        </div>
        <p className="text-sm text-muted">
          前の設定は履歴として残ります。適用開始日より前の予定と、記録済み・開始時刻を過ぎた予定は変わりません。
        </p>
        {notice && <p className="text-sm text-muted">{notice}</p>}
        <ErrorBox message={error} />
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={btnSecondary} disabled={busy} onClick={() => setStep("edit")}>
            戻る
          </button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={save}>
            {busy ? "保存中…" : "保存する"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">ルーティンを編集</h2>
      <RoutineForm value={value} onChange={setValue} errors={showErrors ? errors : {}} />
      <label className="block">
        <span className="text-sm font-bold">適用開始日</span>
        <input
          type="date"
          className={inputBase}
          min={latest.valid_from > today ? latest.valid_from : today}
          value={validFrom}
          onChange={(e) => setValidFrom(e.target.value)}
        />
        {showErrors && vfError && <p className="mt-1 text-sm text-danger">{vfError}</p>}
      </label>
      <label className="block">
        <span className="text-sm font-bold">変更理由（任意、{REASON_MAX}文字まで）</span>
        <input className={inputBase} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：朝は時間が足りないため" />
      </label>
      <ErrorBox message={error} />
      <button type="button" className={`${btnPrimary} w-full`} onClick={toConfirm}>
        変更内容を確認
      </button>

      <div className="border-t border-border pt-4">
        {archiveAsk ? (
          <div className={`${card} space-y-3`}>
            <p className="text-sm">
              アーカイブすると、これからの予定は作られません。まだ始まっていない予定は取り消されます。過去の予定・実績・設定の履歴は残ります。
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={btnSecondary} disabled={busy} onClick={() => setArchiveAsk(false)}>
                やめる
              </button>
              <button type="button" className={btnDanger} disabled={busy} onClick={archive}>
                アーカイブする
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={`${btnDanger} w-full`} onClick={() => setArchiveAsk(true)}>
            このルーティンをアーカイブ
          </button>
        )}
      </div>
    </div>
  );
}
