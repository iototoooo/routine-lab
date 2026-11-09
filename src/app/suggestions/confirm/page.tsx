"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { EvidenceView, SettingsDiff, ruleTitle } from "@/components/suggestions";
import { ErrorBox, Loading, btnPrimary, btnSecondary, card, inputBase } from "@/components/ui";
import { acceptSuggestion } from "@/lib/data/api";
import { errorMessage } from "@/lib/data/errors";
import { REASON_MAX } from "@/lib/domain/routine";
import { loadSuggestions, type LoadedSuggestions } from "@/lib/suggestions/load";
import { defaultReason, removedDates, type Suggestion } from "@/lib/suggestions/rules";
import { addDays, formatDateShort, jstDate, weekdayShort } from "@/lib/time/jst";

// 改善提案の確認画面（F-604）：承認の前に、変更前と変更後・根拠・適用開始日・予定と通知への影響を示す。
// 開いた時点で記録から計算し直す（データや設定が変わって提案がなくなっていれば、承認できない）。
// 承認すると DB（accept_suggestion）が、もとにした版が今の版のままかを確かめてから、新しい版を1つ作る。

export default function ConfirmPage() {
  return (
    <AppShell title="提案の確認" back={{ href: "/suggestions/", label: "提案" }}>
      <AuthGate>
        {() => (
          <Suspense fallback={<Loading />}>
            <ConfirmBody />
          </Suspense>
        )}
      </AuthGate>
    </AppShell>
  );
}

function ConfirmBody() {
  const params = useSearchParams();
  const routineId = params.get("r") ?? "";
  const ruleId = params.get("rule") ?? "";
  const today = jstDate(new Date());
  const [loaded, setLoaded] = useState<LoadedSuggestions | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadSuggestions(today)
      .then(setLoaded)
      .catch((e) => setError(errorMessage(e)));
  }, [today]);

  if (error && !loaded) return <ErrorBox message={error} />;
  if (!loaded) return <Loading />;
  const s = loaded.result.suggestions.find((x) => x.routineId === routineId && x.ruleId === ruleId);
  if (!s) {
    return (
      <div className="space-y-3">
        <p className={`${card} text-sm`}>
          この提案は今は出ていません。記録や設定が変わったか、すでに判断済みです。提案の一覧を開き直してください。
        </p>
        <Link href="/suggestions/" className={btnSecondary}>
          提案の一覧へ
        </Link>
      </div>
    );
  }
  const base = loaded.versions.find((v) => v.id === s.baseVersionId)!;
  return <ConfirmForm s={s} minFrom={base.valid_from > today ? base.valid_from : today} today={today} />;
}

function ConfirmForm({ s, minFrom, today }: { s: Suggestion; minFrom: string; today: string }) {
  const router = useRouter();
  const tomorrow = addDays(today, 1);
  const maxFrom = addDays(today, 365);
  const [validFrom, setValidFrom] = useState(minFrom > tomorrow ? minFrom : tomorrow);
  const [reason, setReason] = useState(defaultReason(s));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validFromOk = /^\d{4}-\d{2}-\d{2}$/.test(validFrom) && validFrom >= minFrom && validFrom <= maxFrom;
  const removed = s.evidence.rule === "R-02" ? s.evidence.weekday : null;

  const accept = async () => {
    if (!validFromOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      await acceptSuggestion(s, validFrom, reason);
      router.replace(`/routines/detail/?id=${s.routineId}&accepted=1`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-muted">
          {s.ruleId}・{s.routineName}（第{s.baseVersionNo}版への提案）
        </p>
        <h2 className="text-lg font-bold">{ruleTitle(s.ruleId)}</h2>
      </div>
      <div className={`${card} space-y-3`}>
        <SettingsDiff current={s.current} proposed={s.proposed} caption="変更前と変更後" />
        <EvidenceView s={s} />
      </div>

      {removed !== null && (
        <div className="rounded-md border border-danger p-3 text-sm" role="note">
          <p className="font-bold">{weekdayShort(removed)}曜日の予定がなくなります</p>
          <p className="mt-1">
            適用開始日から、{weekdayShort(removed)}曜日の予定は作られなくなります（例：
            {removedDates(removed, validFromOk ? validFrom : minFrom)
              .map(formatDateShort)
              .join("、")}
            ）。すでに作られた予定のうち、まだ通知していないものは「取り消し」になります（記録としては残ります）。
          </p>
        </div>
      )}

      <label className="block">
        <span className="text-sm font-bold">適用開始日</span>
        <input
          type="date"
          className={inputBase}
          min={minFrom}
          max={maxFrom}
          value={validFrom}
          onChange={(e) => setValidFrom(e.target.value)}
        />
        {!validFromOk && <p className="mt-1 text-sm text-danger">適用開始日は {formatDateShort(minFrom)} から1年以内にしてください。</p>}
      </label>
      <label className="block">
        <span className="text-sm font-bold">変更理由（{REASON_MAX}文字まで）</span>
        <input className={inputBase} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>

      <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
        <li>今の設定は第{s.baseVersionNo}版として履歴に残り、新しい設定は第{s.baseVersionNo + 1}版になります（きっかけ：改善提案）。</li>
        <li>適用開始日より前の予定と、通知済み・記録済みの予定は変わりません。実績も書き換えません。</li>
        <li>適用開始日以降の、まだ通知していない予定は新しい設定に合わせ、通知の時刻も付け直します。</li>
        <li>あとで元に戻したいときは、ルーティンの「設定の履歴」から元の設定で新しい版を作れます。</li>
      </ul>

      <ErrorBox message={error} />
      <div className="grid grid-cols-2 gap-2">
        <Link href="/suggestions/" className={btnSecondary}>
          戻る
        </Link>
        <button type="button" className={btnPrimary} disabled={busy || !validFromOk} onClick={accept}>
          {busy ? "保存中…" : "承認して新しい版を作る"}
        </button>
      </div>
    </div>
  );
}
