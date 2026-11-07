"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { ErrorBox, Loading, Section, btnPrimary, card } from "@/components/ui";
import { listRoutines, type RoutineWithVersions } from "@/lib/data/api";
import { errorMessage } from "@/lib/data/errors";
import { formatDuration, formatWeekdays } from "@/lib/domain/routine";
import { hhmm, latestVersion, versionOn } from "@/lib/domain/versions";
import { formatDateShort, jstDate } from "@/lib/time/jst";

// S-04 ルーティン一覧：有効なルーティンとアーカイブ済み（表示だけ。復元は F-104 で後から）

export default function RoutinesPage() {
  return (
    <AppShell title="ルーティン">
      <AuthGate>{() => <RoutineList />}</AuthGate>
    </AppShell>
  );
}

function RoutineList() {
  const [items, setItems] = useState<RoutineWithVersions[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listRoutines()
      .then(setItems)
      .catch((e) => {
        setError(errorMessage(e));
        setItems([]);
      });
  }, []);

  if (items === null) return <Loading />;
  const today = jstDate(new Date());
  const active = items.filter((r) => !r.archived_at);
  const archived = items.filter((r) => r.archived_at);

  return (
    <div className="space-y-6">
      <ErrorBox message={error} />
      <Link href="/routines/edit/" className={`${btnPrimary} w-full`}>
        ＋ 新しいルーティン
      </Link>
      <Section title={`登録中（${active.length}）`}>
        {active.length === 0 ? (
          <p className={`${card} text-muted`}>まだありません。上のボタンから登録してください。</p>
        ) : (
          <ul className="space-y-2">
            {active.map((r) => {
              const cur = versionOn(r.versions, today) ?? latestVersion(r.versions);
              const next = latestVersion(r.versions);
              const upcoming = next && next.valid_from > today ? next : null;
              return (
                <li key={r.id}>
                  <Link href={`/routines/detail/?id=${r.id}`} className={`${card} block min-h-11`}>
                    <p className="break-words font-bold">{r.name}</p>
                    {cur && (
                      <p className="text-sm text-muted">
                        {formatWeekdays(cur.weekdays)} {hhmm(cur.start_time)}〜 {formatDuration(cur.duration_min)}
                      </p>
                    )}
                    {upcoming && (
                      <p className="text-sm text-accent">
                        {formatDateShort(upcoming.valid_from)} から変更：{formatWeekdays(upcoming.weekdays)} {hhmm(upcoming.start_time)}〜{" "}
                        {formatDuration(upcoming.duration_min)}
                      </p>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {archived.length > 0 && (
        <details className="space-y-2">
          <summary className="flex min-h-11 cursor-pointer items-center font-bold">アーカイブ済み（{archived.length}）</summary>
          <ul className="mt-2 space-y-2">
            {archived.map((r) => (
              <li key={r.id}>
                <Link href={`/routines/detail/?id=${r.id}`} className={`${card} block min-h-11 text-muted`}>
                  {r.name}
                  <span className="text-sm">（{formatDateShort(jstDate(new Date(r.archived_at!)))} にアーカイブ）</span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
