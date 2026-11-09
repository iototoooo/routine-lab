"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { delayLabel } from "@/components/OccurrenceCard";
import { ErrorBox, Loading, Section, StatusBadge, btnSecondary, card } from "@/components/ui";
import { getRoutine, listDecisions, listRoutineOccurrences, loadRoutineFacts, setRoutineAnalytics, type RoutineWithVersions } from "@/lib/data/api";
import { ruleTitle } from "@/components/suggestions";
import type { Decision } from "@/lib/suggestions/rules";
import type { FactRow } from "@/lib/analytics/types";
import { formatMinutes, formatRate, type Rate, type Sample } from "@/lib/analytics/stats";
import { compareWithPrevious, versionStats, type ComparedWindow } from "@/lib/analytics/versions";
import { errorMessage } from "@/lib/data/errors";
import type { OccurrenceView } from "@/lib/data/types";
import { formatDuration, formatWeekdays } from "@/lib/domain/routine";
import { hhmm, latestVersion, neverEffective, periodLabel, versionOn } from "@/lib/domain/versions";
import { addDays, formatDateShort, jstDate, jstTime } from "@/lib/time/jst";

// S-06 ルーティン詳細（F-105）：版の履歴（設定・有効期間・変更理由・きっかけ）と、直近4週の予定と実績。
// Phase 3：版ごとの集計と直前の版との比較（期間と件数を明示）、「分析に含めない（テスト用）」の切り替え
// Phase 4：版の比較画面・改善提案への入口、提案から作った版のきっかけ（ルール）と「この変更を取り消す」

export default function RoutineDetailPage() {
  return (
    <AppShell title="ルーティン" back={{ href: "/routines/", label: "一覧" }}>
      <AuthGate>
        {() => (
          <Suspense fallback={<Loading />}>
            <DetailBody />
          </Suspense>
        )}
      </AuthGate>
    </AppShell>
  );
}

function DetailBody() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const accepted = params.get("accepted") === "1";
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [routine, setRoutine] = useState<RoutineWithVersions | null | undefined>(undefined);
  const [occ, setOcc] = useState<OccurrenceView[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const today = jstDate(new Date());
    const from = addDays(today, -27);
    Promise.all([getRoutine(id), listRoutineOccurrences(id, from), loadRoutineFacts(id, today), listDecisions(id)])
      .then(([r, o, f, d]) => {
        setRoutine(r);
        setOcc(o);
        setFacts(f);
        setDecisions(d);
      })
      .catch((e) => {
        setError(errorMessage(e));
        setRoutine(null);
      });
  }, [id]);

  if (routine === undefined) return <Loading />;
  if (!routine) return <ErrorBox message={error ?? "ルーティンが見つかりませんでした。"} />;

  const today = jstDate(new Date());
  const cur = versionOn(routine.versions, today) ?? latestVersion(routine.versions);
  const history = [...routine.versions].sort((a, b) => b.version_no - a.version_no);
  const perVersion = versionStats(facts, routine.versions);
  const latest = latestVersion(routine.versions);
  const comparison = latest ? compareWithPrevious(facts, routine.versions, latest.id, today) : null;
  const toggleAnalytics = async () => {
    setSaving(true);
    setError(null);
    try {
      await setRoutineAnalytics(routine.id, !routine.exclude_from_analytics);
      setRoutine({ ...routine, exclude_from_analytics: !routine.exclude_from_analytics });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const decisionOf = (versionId: string) => decisions.find((d) => d.applied_version_id === versionId);
  const comparable = routine.versions.filter((v) => !neverEffective(v) && v.valid_from <= today).length >= 2;

  return (
    <div className="space-y-6">
      {accepted && latest && (
        <p className={`${card} text-sm`} role="status">
          提案を承認し、第{latest.version_no}版を作りました（{formatDateShort(latest.valid_from)} から）。元に戻したいときは「設定の履歴」から取り消せます。
        </p>
      )}
      <div className={card}>
        <p className="break-words text-lg font-bold">{routine.name}</p>
        {cur && (
          <p className="text-muted">
            {formatWeekdays(cur.weekdays)} {hhmm(cur.start_time)}〜 {formatDuration(cur.duration_min)}・再通知 {cur.snooze_min}分後
          </p>
        )}
        {routine.note && <p className="mt-1 text-sm whitespace-pre-wrap">{routine.note}</p>}
        {routine.archived_at ? (
          <p className="mt-2 text-sm text-muted">
            {formatDateShort(jstDate(new Date(routine.archived_at)))} にアーカイブしました。
          </p>
        ) : (
          <Link href={`/routines/edit/?id=${routine.id}`} className={`${btnSecondary} mt-3`}>
            編集する
          </Link>
        )}
      </div>

      <Section title="分析">
        <div className={`${card} space-y-3 text-sm`}>
          <Link href={`/analytics/?r=${routine.id}&p=12w`} className={btnSecondary}>
            このルーティンを分析で見る
          </Link>
          <div className="grid grid-cols-2 gap-2">
            {comparable ? (
              <Link href={`/routines/compare/?id=${routine.id}`} className={btnSecondary}>
                版を選んで比べる
              </Link>
            ) : (
              <span className={`${btnSecondary} opacity-60`} aria-disabled="true">
                版の比較（版が1つだけ）
              </span>
            )}
            <Link href="/suggestions/" className={btnSecondary}>
              改善提案を見る
            </Link>
          </div>
          <div>
            <p>
              分析での扱い：
              <span className="font-bold">{routine.exclude_from_analytics ? "含めない（テスト用）" : "含める"}</span>
            </p>
            <button type="button" className={`${btnSecondary} mt-2`} onClick={toggleAnalytics} disabled={saving}>
              {routine.exclude_from_analytics ? "分析に含める" : "分析に含めない（テスト用にする）"}
            </button>
            <p className="mt-1 text-xs text-muted">
              テスト用にすると、全体の分析から外れます（このルーティンを選べば見られます）。予定・記録・通知は変わりません。
            </p>
            <ErrorBox message={error} />
          </div>
        </div>
      </Section>

      <Section title="版ごとの集計">
        {perVersion.length === 0 ? (
          <p className="text-sm text-muted">まだ記録がありません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">版ごとの集計</caption>
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-2 font-normal">版・期間</th>
                  <th className="py-1 pr-2 font-normal">達成率</th>
                  <th className="py-1 font-normal">遅れ（中央値）</th>
                </tr>
              </thead>
              <tbody>
                {perVersion.map((v) => (
                  <tr key={v.version.id} className="border-t border-border align-top">
                    <td className="py-2 pr-2">
                      第{v.version.version_no}版
                      <span className="block text-xs text-muted">
                        {formatDateShort(v.from)}〜{v.to ? formatDateShort(v.to) : ""}
                      </span>
                      <span className="block text-xs text-muted">
                        {hhmm(v.version.start_time)}〜 {formatDuration(v.version.duration_min)}
                      </span>
                    </td>
                    <td className="py-2 pr-2">
                      <RateCell rate={v.stats.rate} />
                    </td>
                    <td className="py-2">
                      <SampleCell s={v.stats.delayMedian} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {comparison && (
          <div className={`${card} text-sm`}>
            <p className="font-bold">
              第{comparison.before.version.version_no}版と第{comparison.after.version.version_no}版（同じ {comparison.days} 日間で比較）
            </p>
            <dl className="mt-1 space-y-1">
              <CompareRow label="変更前" w={comparison.before} />
              <CompareRow label="変更後" w={comparison.after} />
            </dl>
            {comparison.warnings.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {comparison.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>

      <Section title="設定の履歴">
        <ol className="space-y-2">
          {history.map((v) => (
            <li key={v.id} className={`${card} text-sm ${neverEffective(v) ? "opacity-70" : ""}`}>
              <p className="font-bold">
                第{v.version_no}版 <span className="font-normal text-muted">{periodLabel(v, (d) => addDays(d, -1))}</span>
              </p>
              <p>
                {v.name}：{formatWeekdays(v.weekdays)} {hhmm(v.start_time)}〜 {formatDuration(v.duration_min)}
              </p>
              <p className="text-muted">
                {v.version_no === 1 ? "登録" : `変更理由：${v.change_reason ?? "（なし）"}`}・きっかけ：
                {v.source === "suggestion"
                  ? `改善提案${decisionOf(v.id) ? `（${decisionOf(v.id)!.rule_id}「${ruleTitle(decisionOf(v.id)!.rule_id)}」）` : ""}`
                  : "手動"}
              </p>
              {v.source === "suggestion" && latest && v.id === latest.id && !routine.archived_at && (
                <Link href={`/routines/edit/?id=${routine.id}&revert=${v.id}`} className={`${btnSecondary} mt-2`}>
                  この変更を取り消す（元の設定に戻す）
                </Link>
              )}
            </li>
          ))}
        </ol>
      </Section>

      <Section title="直近4週の予定と実績">
        {occ.length === 0 ? (
          <p className="text-sm text-muted">まだ予定がありません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-2 font-normal">予定日</th>
                  <th className="py-1 pr-2 font-normal">予定</th>
                  <th className="py-1 pr-2 font-normal">状態</th>
                  <th className="py-1 font-normal">実績</th>
                </tr>
              </thead>
              <tbody>
                {occ.map((o) => (
                  <tr key={o.id} className="border-t border-border align-top">
                    <td className="py-2 pr-2 whitespace-nowrap">
                      <Link href={`/record/?o=${o.id}`} className="text-accent underline">
                        {formatDateShort(o.planned_date)}
                      </Link>
                    </td>
                    <td className="py-2 pr-2 whitespace-nowrap">
                      {jstTime(new Date(o.planned_start_at))}・{o.planned_duration_min}分
                    </td>
                    <td className="py-2 pr-2">
                      <StatusBadge status={o.status} />
                      {o.postpone_count > 0 && <span className="block text-xs text-muted">延期{o.postpone_count}回</span>}
                    </td>
                    <td className="py-2">
                      {o.execution ? (
                        <>
                          {jstTime(new Date(o.execution.actual_start_at))}・{o.execution.actual_duration_min}分
                          <span className="block text-xs text-muted">
                            {delayLabel(o.planned_start_at, o.execution.actual_start_at)}
                            {o.execution.is_late_day ? "・翌日以降" : ""}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function RateCell({ rate }: { rate: Rate }) {
  if (rate.rate === null) return <span className="text-muted">データなし</span>;
  return (
    <span>
      {formatRate(rate)}
      {rate.reference && <span className="ml-1 inline-block whitespace-nowrap rounded border border-border px-1 text-xs text-muted">参考値</span>}
    </span>
  );
}

function SampleCell({ s }: { s: Sample }) {
  if (s.value === null) return <span className="text-muted">データなし</span>;
  return (
    <span>
      {formatMinutes(s.value)}（{s.n}件）
      {s.reference && <span className="ml-1 inline-block whitespace-nowrap rounded border border-border px-1 text-xs text-muted">参考値</span>}
    </span>
  );
}

function CompareRow({ label, w }: { label: string; w: ComparedWindow }) {
  return (
    <div>
      <dt className="text-muted">
        {label}：第{w.version.version_no}版 {formatDateShort(w.from)}〜{formatDateShort(w.to)}
      </dt>
      <dd>
        達成率 <RateCell rate={w.stats.rate} />・遅れ <SampleCell s={w.stats.delayMedian} />
      </dd>
    </div>
  );
}
