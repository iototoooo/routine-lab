"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { EvidenceView, SettingsDiff, ruleTitle, settingChanges } from "@/components/suggestions";
import { ErrorBox, Loading, Section, btnPrimary, btnSecondary, card } from "@/components/ui";
import { rejectSuggestion } from "@/lib/data/api";
import { errorMessage } from "@/lib/data/errors";
import { loadSuggestions, type LoadedSuggestions } from "@/lib/suggestions/load";
import type { Suggestion } from "@/lib/suggestions/rules";
import { MIN_FINAL, SUPPRESS_DAYS } from "@/lib/suggestions/thresholds";
import { formatDateShort, jstDate } from "@/lib/time/jst";

// S-08 改善提案（F-601〜604、docs/phase4-plan.md 4章）。
// 提案は開くたびに記録から計算する（自動では反映しない）。承認は確認画面（/suggestions/confirm/）からだけ。
// 却下は判断だけを記録し、同じルーティン・同じルールは 28 日間出さない。

export default function SuggestionsPage() {
  return (
    <AppShell title="改善提案" back={{ href: "/analytics/", label: "分析" }}>
      <AuthGate>{() => <SuggestionsBody />}</AuthGate>
    </AppShell>
  );
}

type Loaded = LoadedSuggestions;

function SuggestionsBody() {
  const today = jstDate(new Date());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    loadSuggestions(today)
      .then(setLoaded)
      .catch((e) => setError(errorMessage(e)));
  }, [today]);
  useEffect(reload, [reload]);

  if (error && !loaded) return <ErrorBox message={error} />;
  if (!loaded) return <Loading />;
  const { result, decisions, names } = loaded;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        直近 4 週（昨日まで）の記録から、設定の見直しを提案します。提案は自動では反映されません。内容を確認して「承認」したときだけ、新しい版として記録されます。
      </p>

      <Section title={`今の提案（${result.suggestions.length} 件）`}>
        {result.suggestions.length === 0 ? (
          <p className={`${card} text-sm`}>今は提案はありません。</p>
        ) : (
          <ul className="space-y-3">
            {result.suggestions.map((s) => (
              <SuggestionCard key={`${s.routineId}-${s.ruleId}`} s={s} onRejected={reload} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="ルーティンごとの状況">
        {result.notes.length === 0 ? (
          <p className="text-sm text-muted">対象のルーティンがありません（テスト用・アーカイブ済みは対象外です）。</p>
        ) : (
          <ul className={`${card} divide-y divide-border text-sm`}>
            {result.notes.map((n) => (
              <li key={n.routineId} className="py-2">
                <p className="font-bold">{n.routineName}</p>
                {n.finals < MIN_FINAL ? (
                  <p>
                    <span className="mr-1 inline-block whitespace-nowrap rounded border border-border px-1 text-xs text-muted">データ不足</span>
                    今の設定で確定した予定 {n.finals} 件（提案には {MIN_FINAL} 件以上が必要です）
                  </p>
                ) : (
                  <p className="text-muted">確定した予定 {n.finals} 件</p>
                )}
                {n.suppressed.map((x) => (
                  <p key={x.ruleId} className="text-xs text-muted">
                    {x.ruleId}「{ruleTitle(x.ruleId)}」は判断済みのため{x.until ? ` ${formatDateShort(x.until)} まで` : "、今の設定では"}出しません。
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">
          テスト用（分析に含めない）・アーカイブ済みのルーティンには提案を出しません。却下・承認した提案は、同じルーティン・同じ種類のものを {SUPPRESS_DAYS} 日間出しません。
        </p>
      </Section>

      <Section title="判断の記録">
        {decisions.length === 0 ? (
          <p className="text-sm text-muted">まだありません。</p>
        ) : (
          <ul className="space-y-2">
            {decisions.map((d) => (
              <li key={d.id} className={`${card} text-sm`}>
                <p>
                  <span className="font-bold">{d.status === "accepted" ? "承認" : "却下"}</span>・{formatDateShort(jstDate(new Date(d.decided_at)))}・
                  <Link href={`/routines/detail/?id=${d.routine_id}`} className="text-accent underline">
                    {names.get(d.routine_id) ?? "（不明）"}
                  </Link>
                </p>
                <p className="text-muted">
                  {d.rule_id}「{ruleTitle(d.rule_id)}」：
                  {settingChanges(d.current_settings, d.proposed)
                    .map((c) => `${c.label} ${c.before} → ${c.after}`)
                    .join("、")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function SuggestionCard({ s, onRejected }: { s: Suggestion; onRejected: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reject = async () => {
    setBusy(true);
    setError(null);
    try {
      await rejectSuggestion(s);
      onRejected();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <li className={`${card} space-y-3`}>
      <div>
        <p className="text-xs text-muted">
          {s.ruleId}・{s.routineName}
        </p>
        <h3 className="font-bold">{ruleTitle(s.ruleId)}</h3>
      </div>
      <EvidenceView s={s} />
      <SettingsDiff current={s.current} proposed={s.proposed} caption={`${s.routineName}への提案`} />
      <ErrorBox message={error} />
      {asking ? (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          <p>この提案を却下しますか？ 設定は変わりません。同じ種類の提案は {SUPPRESS_DAYS} 日間出なくなります。</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className={btnSecondary} disabled={busy} onClick={() => setAsking(false)}>
              やめる
            </button>
            <button type="button" className={btnPrimary} disabled={busy} onClick={reject}>
              {busy ? "記録中…" : "却下する"}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={btnSecondary} onClick={() => setAsking(true)}>
            却下する
          </button>
          <Link href={`/suggestions/confirm/?r=${s.routineId}&rule=${s.ruleId}`} className={btnPrimary}>
            内容を確認する
          </Link>
        </div>
      )}
    </li>
  );
}
