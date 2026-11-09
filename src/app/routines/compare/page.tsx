"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { settingChanges } from "@/components/suggestions";
import { ErrorBox, Loading, card, inputBase } from "@/components/ui";
import { getRoutine, loadRoutineFacts, type RoutineWithVersions } from "@/lib/data/api";
import { errorMessage } from "@/lib/data/errors";
import { REASON_KEYS } from "@/lib/analytics/reasons";
import { formatMinutes, formatRate, type Rate, type Sample } from "@/lib/analytics/stats";
import type { FactRow, RecordFilter } from "@/lib/analytics/types";
import { comparableVersions, compareVersions, type ComparedWindow } from "@/lib/analytics/versions";
import { REASON_LABEL } from "@/lib/domain/reasons";
import { settingsOf } from "@/lib/suggestions/rules";
import { formatDateShort, jstDate } from "@/lib/time/jst";

// S-09 変更前後の比較（F-701・F-702、docs/phase4-plan.md 4章）。
// 2つの版を選び、前の版の最後の N 日と後の版の最初の N 日（N は最大 28 日、短いほうにそろえる）で比べる。
// 比べた期間・件数・注意を必ず示す。5件未満は「参考値」、まだ比べられないときは「データ不足」。
// クエリ文字列：id=ルーティン、a=前の版、b=後の版、src=measured で実測・時刻指定だけ。

export default function ComparePage() {
  return (
    <AppShell title="変更前後の比較" back={{ href: "/routines/", label: "一覧" }}>
      <AuthGate>
        {() => (
          <Suspense fallback={<Loading />}>
            <CompareBody />
          </Suspense>
        )}
      </AuthGate>
    </AppShell>
  );
}

const ref = "ml-1 inline-block whitespace-nowrap rounded border border-border px-1 text-xs text-muted";

function CompareBody() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id") ?? "";
  const today = jstDate(new Date());
  const [routine, setRoutine] = useState<RoutineWithVersions | null | undefined>(undefined);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([getRoutine(id), loadRoutineFacts(id, today)])
      .then(([r, f]) => {
        setRoutine(r);
        setFacts(f);
      })
      .catch((e) => {
        setError(errorMessage(e));
        setRoutine(null);
      });
  }, [id, today]);

  if (routine === undefined) return <Loading />;
  if (!routine) return <ErrorBox message={error ?? "ルーティンが見つかりませんでした。"} />;

  const versions = comparableVersions(routine.versions, today);
  const filter: RecordFilter = params.get("src") === "measured" ? "measured" : "all";
  const a = versions.find((v) => v.id === params.get("a")) ?? versions.at(-2);
  const b = versions.find((v) => v.id === params.get("b")) ?? versions.at(-1);
  const update = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    router.replace(`/routines/compare/?${q.toString()}`, { scroll: false });
  };
  const back = (
    <Link href={`/routines/detail/?id=${routine.id}`} className="text-sm text-accent underline">
      {routine.name} の詳細へ
    </Link>
  );

  if (versions.length < 2 || !a || !b) {
    return (
      <div className="space-y-3">
        <p className="font-bold">{routine.name}</p>
        <p className={`${card} text-sm`}>
          <span className={ref}>データ不足</span> 比べられる版が 2 つ以上ありません。設定を変えてから、新しい設定で記録すると比べられます。
        </p>
        {back}
      </div>
    );
  }

  const c = compareVersions(facts, routine.versions, a.id, b.id, today, 4, filter);
  const label = (v: (typeof versions)[number]) =>
    `第${v.version_no}版 ${Number(v.valid_from.slice(5, 7))}/${Number(v.valid_from.slice(8, 10))}〜${v.source === "suggestion" ? "（提案）" : ""}`;

  return (
    <div className="space-y-4">
      <p className="font-bold">{routine.name}</p>
      <div className={`${card} space-y-3`} role="group" aria-label="比べる版">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            変更前の版
            <select className={inputBase} value={a.id} onChange={(e) => update({ a: e.target.value })}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {label(v)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            変更後の版
            <select className={inputBase} value={b.id} onChange={(e) => update({ b: e.target.value })}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {label(v)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={filter === "measured"}
            onChange={(e) => update({ src: e.target.checked ? "measured" : null })}
          />
          遅れ・所要時間は「実測・時刻指定」の記録だけで計算する
        </label>
        {settingChanges(settingsOf(a), settingsOf(b)).length > 0 && (
          <p className="text-sm text-muted">
            設定の違い：
            {settingChanges(settingsOf(a), settingsOf(b))
              .map((x) => `${x.label} ${x.before} → ${x.after}`)
              .join("、")}
          </p>
        )}
      </div>

      {!c ? (
        <p className={`${card} text-sm`}>
          <span className={ref}>データ不足</span>{" "}
          {a.version_no >= b.version_no
            ? "「変更前の版」には「変更後の版」より古い版を選んでください。"
            : "まだ比べられる日がありません。変更後の版で1日以上たつと比べられます。"}
        </p>
      ) : (
        <>
          <p className="text-sm">
            同じ <span className="font-bold">{c.days} 日間</span>で比較：変更前 {formatDateShort(c.before.from)}〜{formatDateShort(c.before.to)}、変更後{" "}
            {formatDateShort(c.after.from)}〜{formatDateShort(c.after.to)}
          </p>
          <CompareTable before={c.before} after={c.after} />
          {c.warnings.length > 0 && (
            <ul className="space-y-1 text-sm text-muted" aria-label="注意">
              {c.warnings.map((w) => (
                <li key={w}>注意：{w}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">
            達成率の分母は完了・見送り・未実施（まだ確定していない予定は入れません）。比較の期間は予定日（JST）で、今日までです。
          </p>
        </>
      )}
      {back}
    </div>
  );
}

function RateText({ r }: { r: Rate }) {
  if (r.rate === null) return <span className="text-muted">データなし</span>;
  return (
    <span>
      {formatRate(r)}
      {r.reference && <span className={ref}>参考値</span>}
    </span>
  );
}

function SampleText({ s, format }: { s: Sample; format: (v: number) => string }) {
  if (s.value === null) return <span className="text-muted">データなし</span>;
  return (
    <span>
      {format(s.value)}（{s.n}件）
      {s.reference && <span className={ref}>参考値</span>}
    </span>
  );
}

function CompareTable({ before, after }: { before: ComparedWindow; after: ComparedWindow }) {
  const rows: [string, (w: ComparedWindow) => ReactNode][] = [
    ["達成率", (w) => <RateText r={w.stats.rate} />],
    ["遅れ（中央値）", (w) => <SampleText s={w.stats.delayMedian} format={formatMinutes} />],
    ["±10分以内に開始", (w) => <RateText r={w.stats.onTime} />],
    ["翌日以降に実施", (w) => <RateText r={w.stats.lateDay} />],
    ["所要時間（実際÷予定の中央値）", (w) => <SampleText s={w.stats.durationRatio} format={(v) => `${Math.round(v * 100) / 100}倍`} />],
    ["延期した予定", (w) => <RateText r={w.stats.postponed} />],
    [
      "見送り・未実施の理由",
      (w) => {
        const items = REASON_KEYS.filter((k) => w.stats.reasons[k] > 0).map(
          (k) => `${k === "none" ? "理由なし" : REASON_LABEL[k]} ${w.stats.reasons[k]}件`,
        );
        return items.length === 0 ? <span className="text-muted">なし</span> : items.join("、");
      },
    ],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">変更前と変更後の比較</caption>
        <thead>
          <tr className="text-left text-muted">
            <th className="py-1 pr-2 font-normal">指標</th>
            <th className="py-1 pr-2 font-normal">変更前（第{before.version.version_no}版）</th>
            <th className="py-1 font-normal">変更後（第{after.version.version_no}版）</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, cell]) => (
            <tr key={name} className="border-t border-border align-top">
              <th className="py-2 pr-2 text-left font-normal">{name}</th>
              <td className="py-2 pr-2">{cell(before)}</td>
              <td className="py-2">{cell(after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
