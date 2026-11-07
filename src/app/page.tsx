"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { OccurrenceCard } from "@/components/OccurrenceCard";
import { ErrorBox, Loading, Section, btnPrimary, card, useNow } from "@/components/ui";
import { ensureOccurrences, listOccurrences, recordDone } from "@/lib/data/api";
import { errorMessage } from "@/lib/data/errors";
import type { OccurrenceView } from "@/lib/data/types";
import { canRecord } from "@/lib/domain/status";
import { addDays, formatDateShort, jstDate, jstTime } from "@/lib/time/jst";

// S-02 今日（F-310）：今日の予定と、前日の未記録の予定。通知が届かなくても、開けば記録できる（NF-05）。
// 開いたときに ensure_occurrences で今日と明日の予定を作り、期限を過ぎた予定を未実施にする（F-201・F-406）。

export default function TodayPage() {
  return (
    <AppShell title="今日">
      <AuthGate>{() => <Today />}</AuthGate>
    </AppShell>
  );
}

function Today() {
  const now = useNow();
  const today = jstDate(now);
  const [items, setItems] = useState<OccurrenceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      await ensureOccurrences();
      const t = jstDate(new Date());
      setItems(await listOccurrences([addDays(t, -1), t, addDays(t, 1)]));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      setItems((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    // 開いたとき（と日付が変わったとき）に読み込む。外部（DB）との同期なので effect で行う
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, today]);

  async function quickDone(o: OccurrenceView) {
    setBusy(true);
    try {
      await recordDone(o.id, new Date(o.planned_start_at), o.planned_duration_min, "planned");
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (items === null) return <Loading />;

  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const todays = items.filter((o) => o.planned_date === today && o.status !== "cancelled");
  const leftovers = items.filter((o) => o.planned_date === yesterday && canRecord(o, now));
  const tomorrows = items.filter((o) => o.planned_date === tomorrow && o.status !== "cancelled");

  return (
    <div className="space-y-6">
      <ErrorBox message={error} />

      {leftovers.length > 0 && (
        <Section title={`昨日の未記録（${formatDateShort(yesterday)}）`}>
          <p className="text-sm text-muted">今日の終わりまで記録できます。過ぎると「未実施」になります。</p>
          <ul className="space-y-2">
            {leftovers.map((o) => (
              <OccurrenceCard key={o.id} o={o} now={now} busy={busy} />
            ))}
          </ul>
        </Section>
      )}

      <Section title={`今日 ${formatDateShort(today)}`}>
        {todays.length === 0 ? (
          <div className={card}>
            <p className="text-muted">今日の予定はありません。</p>
            <Link href="/routines/" className={`${btnPrimary} mt-3`}>
              ルーティンを見る
            </Link>
          </div>
        ) : (
          <ul className="space-y-2">
            {todays.map((o) => (
              <OccurrenceCard key={o.id} o={o} now={now} busy={busy} onQuickDone={quickDone} />
            ))}
          </ul>
        )}
      </Section>

      {tomorrows.length > 0 && (
        <Section title={`明日 ${formatDateShort(tomorrow)}`}>
          <ul className="space-y-1 text-sm text-muted">
            {tomorrows.map((o) => (
              <li key={o.id}>
                {jstTime(new Date(o.planned_start_at))} {o.routine_name}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
