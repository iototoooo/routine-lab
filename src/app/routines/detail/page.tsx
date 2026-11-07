"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { delayLabel } from "@/components/OccurrenceCard";
import { ErrorBox, Loading, Section, StatusBadge, btnSecondary, card } from "@/components/ui";
import { getRoutine, listRoutineOccurrences, type RoutineWithVersions } from "@/lib/data/api";
import { errorMessage } from "@/lib/data/errors";
import type { OccurrenceView } from "@/lib/data/types";
import { formatDuration, formatWeekdays } from "@/lib/domain/routine";
import { hhmm, latestVersion, neverEffective, periodLabel, versionOn } from "@/lib/domain/versions";
import { addDays, formatDateShort, jstDate, jstTime } from "@/lib/time/jst";

// S-06 ルーティン詳細（F-105）：版の履歴（設定・有効期間・変更理由・きっかけ）と、直近4週の予定と実績

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
  const id = useSearchParams().get("id") ?? "";
  const [routine, setRoutine] = useState<RoutineWithVersions | null | undefined>(undefined);
  const [occ, setOcc] = useState<OccurrenceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const from = addDays(jstDate(new Date()), -27);
    Promise.all([getRoutine(id), listRoutineOccurrences(id, from)])
      .then(([r, o]) => {
        setRoutine(r);
        setOcc(o);
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

  return (
    <div className="space-y-6">
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
                {v.source === "suggestion" ? "改善提案" : "手動"}
              </p>
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
