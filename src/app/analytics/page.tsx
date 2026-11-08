"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { CountBars, RateBars, RateColumns, type CountItem, type RateItem } from "@/components/charts";
import { ErrorBox, Loading, Section, card, inputBase } from "@/components/ui";
import { loadAnalyticsData, type AnalyticsData } from "@/lib/data/api";
import { errorMessage } from "@/lib/data/errors";
import type { Bucket, Segment } from "@/lib/analytics/achievement";
import { POSTPONE_COUNT_KEYS, REASON_KEYS, type ReasonKey } from "@/lib/analytics/reasons";
import { analyze, periodRange, PERIOD_KEYS, PERIOD_LABEL, type AnalyticsReport, type PeriodKey } from "@/lib/analytics/report";
import { formatMinutes, formatPoints, formatRate, type Rate, type Sample } from "@/lib/analytics/stats";
import { DELAY_BUCKETS, DELAY_BUCKET_LABEL } from "@/lib/analytics/timing";
import type { RecordFilter } from "@/lib/analytics/types";
import { POSTPONE_LABEL, POSTPONE_OPTIONS } from "@/lib/domain/postpone";
import { REASON_LABEL } from "@/lib/domain/reasons";
import { TIME_BAND_LABEL } from "@/lib/time/bands";
import { formatDateShort, jstDate, weekdayShort } from "@/lib/time/jst";

// S-07 分析（F-501〜509、docs/phase3-plan.md 3〜5章）。
// 集計の決まり：達成率の分母は「完了・見送り・未実施」だけ。未確定は別に数え、完了とも失敗とも扱わない。
// 0件は「データなし」、5件未満は「参考値」。割合には必ず件数を添える。グラフには同じ数値の表を添える。
// 絞り込みはクエリ文字列に入れる（p=期間, from/to, r=ルーティン, test=1 でテスト用も含める, src=measured で実測だけ）。

export default function AnalyticsPage() {
  return (
    <AppShell title="分析">
      <AuthGate>
        {() => (
          <Suspense fallback={<Loading />}>
            <AnalyticsBody />
          </Suspense>
        )}
      </AuthGate>
    </AppShell>
  );
}

const DAILY_MAX_DAYS = 31;
const isPeriod = (v: string | null): v is PeriodKey => (PERIOD_KEYS as readonly string[]).includes(v ?? "");
const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

function AnalyticsBody() {
  const params = useSearchParams();
  const router = useRouter();
  const today = jstDate(new Date());
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAnalyticsData(today)
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, [today]);

  const period: PeriodKey = isPeriod(params.get("p")) ? (params.get("p") as PeriodKey) : "4w";
  const customFrom = params.get("from") ?? "";
  const customTo = params.get("to") ?? "";
  const routineId = params.get("r") || null;
  const includeExcluded = params.get("test") === "1";
  const filter: RecordFilter = params.get("src") === "measured" ? "measured" : "all";
  const range = periodRange(period, today, { from: customFrom, to: customTo });

  const report = useMemo(() => {
    if (!data || !range) return null;
    return analyze(
      { facts: data.facts, events: data.events, routines: data.routines, today },
      { range, routineId, includeExcluded, filter },
    );
    // range はクエリ文字列から毎回作るので、その中身で比べる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, range?.from, range?.to, routineId, includeExcluded, filter, today]);

  const update = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") q.delete(k);
      else q.set(k, v);
    }
    router.replace(`/analytics/?${q.toString()}`, { scroll: false });
  };

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  return (
    <div className="space-y-6">
      <Filters
        data={data}
        period={period}
        customFrom={customFrom || (range?.from ?? today)}
        customTo={customTo || today}
        routineId={routineId}
        includeExcluded={includeExcluded}
        filter={filter}
        update={update}
      />
      {!range || !report ? (
        <ErrorBox message="期間の指定が正しくありません（開始日 ≦ 終了日、長さは1年まで）。" />
      ) : (
        <Report report={report} filter={filter} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// 絞り込み
// ---------------------------------------------------------------------
function Filters(props: {
  data: AnalyticsData;
  period: PeriodKey;
  customFrom: string;
  customTo: string;
  routineId: string | null;
  includeExcluded: boolean;
  filter: RecordFilter;
  update: (patch: Record<string, string | null>) => void;
}) {
  const { data, period, routineId, includeExcluded, filter, update } = props;
  const seg = (active: boolean) =>
    `min-h-11 flex-1 rounded-md border px-2 text-sm ${active ? "border-accent bg-accent font-bold text-accent-foreground" : "border-border bg-surface"}`;
  return (
    <div className={`${card} space-y-3`} role="group" aria-label="絞り込み">
      <div>
        <p className="text-sm text-muted">期間（予定日）</p>
        <div className="mt-1 flex gap-1">
          {PERIOD_KEYS.map((k) => (
            <button key={k} type="button" className={seg(period === k)} aria-pressed={period === k} onClick={() => update({ p: k === "4w" ? null : k })}>
              {PERIOD_LABEL[k]}
            </button>
          ))}
        </div>
        {period === "custom" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-sm">
              開始日
              <input type="date" className={inputBase} value={props.customFrom} onChange={(e) => update({ from: e.target.value, to: props.customTo })} />
            </label>
            <label className="text-sm">
              終了日
              <input type="date" className={inputBase} value={props.customTo} onChange={(e) => update({ from: props.customFrom, to: e.target.value })} />
            </label>
          </div>
        )}
      </div>
      <label className="block text-sm">
        ルーティン
        <select className={inputBase} value={routineId ?? ""} onChange={(e) => update({ r: e.target.value || null })}>
          <option value="">すべて</option>
          {data.routines.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {r.exclude_from_analytics ? "（テスト用）" : ""}
              {r.archived_at ? "（アーカイブ済み）" : ""}
            </option>
          ))}
        </select>
      </label>
      {!routineId && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="size-5" checked={includeExcluded} onChange={(e) => update({ test: e.target.checked ? "1" : null })} />
          テスト用のルーティンも含める
        </label>
      )}
      <div>
        <p className="text-sm text-muted">開始の遅れ・所要時間に使う記録</p>
        <div className="mt-1 flex gap-1">
          <button type="button" className={seg(filter === "all")} aria-pressed={filter === "all"} onClick={() => update({ src: null })}>
            すべて
          </button>
          <button type="button" className={seg(filter === "measured")} aria-pressed={filter === "measured"} onClick={() => update({ src: "measured" })}>
            実測・時刻指定だけ
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// 共通の表示部品
// ---------------------------------------------------------------------
function RefBadge({ rate, n }: { rate?: Rate; n?: number }) {
  const count = rate ? rate.den : (n ?? 0);
  if (count === 0) return null;
  if (count >= 5) return null;
  return <span className="ml-1 inline-block whitespace-nowrap rounded border border-border px-1 text-xs text-muted">参考値</span>;
}

function RateValue({ rate }: { rate: Rate }) {
  return (
    <span>
      {formatRate(rate)}
      <RefBadge rate={rate} />
    </span>
  );
}

function SampleValue({ s, format }: { s: Sample; format: (v: number) => string }) {
  if (s.value === null) return <span className="text-muted">データなし</span>;
  return (
    <span>
      {format(s.value)}（{s.n}件）
      <RefBadge n={s.n} />
    </span>
  );
}

const ratioText = (v: number) => `${v.toFixed(2)}倍`;

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-border py-2 first:border-t-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function DataTable({ head, rows, caption }: { head: string[]; rows: ReactNode[][]; caption: string }) {
  return (
    <details className="text-sm">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-accent">表で見る</summary>
      <table className="w-full">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-left text-muted">
            {head.map((h, i) => (
              <th key={h} className={`py-1 font-normal ${i > 0 ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              {r.map((c, j) => (
                <td key={j} className={`py-1.5 ${j > 0 ? "text-right" : ""}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

const rateCell = (r: Rate) => (r.rate === null ? <span className="text-muted">データなし</span> : <RateValue rate={r} />);
const outcomeCells = (b: Bucket<unknown>) => [b.outcome.done, b.outcome.skipped, b.outcome.missed, b.outcome.open];
const reasonLabel = (k: ReasonKey) => (k === "none" ? "理由なし" : REASON_LABEL[k]);

// ---------------------------------------------------------------------
// 集計結果
// ---------------------------------------------------------------------
function Report({ report, filter }: { report: AnalyticsReport; filter: RecordFilter }) {
  const r = report;
  const days = r.daily.length;
  const toItems = <K,>(xs: Bucket<K>[], label: (k: K) => string): RateItem[] =>
    xs.map((b) => ({ key: String(b.key), label: label(b.key), rate: b.rate }));
  const segRows = <K,>(xs: Segment<K>[], label: (k: K) => string) =>
    xs.map((s) => [label(s.key), rateCell(s.rate), formatPoints(s.diff), ...outcomeCells(s)]);

  return (
    <div className="space-y-8">
      <Section title="まとめ">
        <div className={card}>
          <p className="text-sm text-muted">
            {formatDateShort(r.range.from)} 〜 {formatDateShort(r.range.to)}・
            {r.routines.length === 1 ? r.routines[0]!.name : `${r.routines.length} 件のルーティン`}
          </p>
          <dl className="mt-2">
            <Stat label="達成率（完了 ÷ 確定した予定）">
              <span className="text-lg font-bold">
                <RateValue rate={r.rate} />
              </span>
            </Stat>
            <Stat label="内訳">
              完了 {r.outcome.done}・見送り {r.outcome.skipped}・未実施 {r.outcome.missed}
            </Stat>
            <Stat label="未確定（達成率に入れない）">{r.outcome.open} 件</Stat>
            <Stat label="開始の遅れ（中央値）">
              <SampleValue s={r.delay.median} format={formatMinutes} />
            </Stat>
            <Stat label="所要時間（実際 ÷ 予定の中央値）">
              <SampleValue s={r.duration.ratio} format={ratioText} />
            </Stat>
            <Stat label="延期した予定の割合">
              <RateValue rate={r.postpone.postponed} />
            </Stat>
          </dl>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {r.includesRecent && r.outcome.open > 0 && <li>直近の予定は、予定日の翌日が終わるまで未確定のことがあります（記録していない予定は完了にも未実施にも数えません）。</li>}
            {r.excludedCount > 0 && <li>テスト用のルーティン {r.excludedCount} 件を除いています。</li>}
            {filter === "measured" && <li>開始の遅れ・所要時間は、実測・時刻指定の記録だけで計算しています。</li>}
            <li>5件未満の値は「参考値」です。棒が薄いものも参考値です。</li>
          </ul>
        </div>
      </Section>

      <Section title="推移">
        {days <= DAILY_MAX_DAYS ? (
          <div className={card}>
            <h3 className="text-sm font-bold">日別の達成率</h3>
            <RateColumns title="日別の達成率" items={toItems(r.daily, shortDate)} />
            <DataTable
              caption="日別の達成率"
              head={["日付", "達成率", "完了", "見送り", "未実施", "未確定"]}
              rows={r.daily.map((b) => [formatDateShort(b.key), rateCell(b.rate), ...outcomeCells(b)])}
            />
          </div>
        ) : (
          <p className="text-sm text-muted">日別のグラフは {DAILY_MAX_DAYS} 日以下の期間で表示します。</p>
        )}
        <div className={card}>
          <h3 className="text-sm font-bold">週別の達成率（月曜始まり）</h3>
          <RateColumns title="週別の達成率" items={toItems(r.weekly, (w) => `${shortDate(w)}〜`)} />
          <DataTable
            caption="週別の達成率"
            head={["週", "達成率", "完了", "見送り", "未実施", "未確定"]}
            rows={r.weekly.map((b) => [`${shortDate(b.key)}〜`, rateCell(b.rate), ...outcomeCells(b)])}
          />
        </div>
      </Section>

      <Section title="曜日別">
        <div className={card}>
          <RateBars title="曜日別の達成率" items={toItems(r.weekday, (d) => `${weekdayShort(d)}曜日`)} />
          <DataTable
            caption="曜日別の達成率"
            head={["曜日", "達成率", "他の曜日との差", "完了", "見送り", "未実施", "未確定"]}
            rows={segRows(r.weekday, (d) => `${weekdayShort(d)}曜日`)}
          />
        </div>
      </Section>

      <Section title="時間帯別（予定開始時刻）">
        <div className={card}>
          <RateBars title="時間帯別の達成率" items={toItems(r.timeBand, (b) => TIME_BAND_LABEL[b])} />
          <DataTable
            caption="時間帯別の達成率"
            head={["時間帯", "達成率", "他の時間帯との差", "完了", "見送り", "未実施", "未確定"]}
            rows={segRows(r.timeBand, (b) => TIME_BAND_LABEL[b])}
          />
        </div>
      </Section>

      <Section title="開始の遅れ（実際の開始 − 予定の開始）">
        <div className={card}>
          <dl>
            <Stat label="中央値">
              <SampleValue s={r.delay.median} format={formatMinutes} />
            </Stat>
            <Stat label="平均">
              <SampleValue s={r.delay.mean} format={formatMinutes} />
            </Stat>
            <Stat label="±10分以内に開始">
              <RateValue rate={r.delay.onTime} />
            </Stat>
            <Stat label="予定日の翌日以降に実施">
              <RateValue rate={r.delay.lateDay} />
            </Stat>
          </dl>
          <p className="border-t border-border py-2 text-sm">
            <span className="text-muted">記録のしかた：</span>
            「予定どおり」で記録 {r.delay.sources.planned} 件（入力上の0分）・実測・時刻指定 {r.delay.sources.measured} 件（うち0分{" "}
            {r.delay.measuredZero} 件）
          </p>
          <CountBars
            title="開始の遅れの分布"
            items={DELAY_BUCKETS.map((k): CountItem => ({ key: k, label: DELAY_BUCKET_LABEL[k], count: r.delay.buckets[k] }))}
          />
          <DataTable caption="開始の遅れの分布" head={["区分", "件数"]} rows={DELAY_BUCKETS.map((k) => [DELAY_BUCKET_LABEL[k], r.delay.buckets[k]])} />
        </div>
      </Section>

      <Section title="所要時間（実際 − 予定）">
        <div className={card}>
          <dl>
            <Stat label="実際 ÷ 予定（中央値）">
              <SampleValue s={r.duration.ratio} format={ratioText} />
            </Stat>
            <Stat label="差（中央値）">
              <SampleValue s={r.duration.diff} format={formatMinutes} />
            </Stat>
            <Stat label="予定より長くかかった">
              <RateValue rate={r.duration.longer} />
            </Stat>
            <Stat label="予定より短く終えた">
              <RateValue rate={r.duration.shorter} />
            </Stat>
          </dl>
        </div>
      </Section>

      <Section title="延期">
        <div className={card}>
          <dl>
            <Stat label="延期した予定の割合（確定した予定のうち）">
              <RateValue rate={r.postpone.postponed} />
            </Stat>
            <Stat label="延期した予定の達成率">
              <RateValue rate={r.postpone.afterRate} />
            </Stat>
            <Stat label="延期してから完了したときの遅れ（中央値）">
              <SampleValue s={r.postpone.delayAfter} format={formatMinutes} />
            </Stat>
            <Stat label="延期の操作">{r.postpone.events} 回</Stat>
          </dl>
          <h3 className="mt-3 text-sm font-bold">1つの予定あたりの延期回数</h3>
          <CountBars
            title="延期回数の分布"
            items={POSTPONE_COUNT_KEYS.map((k) => ({ key: k, label: k === "3+" ? "3回以上" : `${k}回`, count: r.postpone.countDist[k] }))}
          />
          <h3 className="mt-3 text-sm font-bold">延期の選択肢</h3>
          <CountBars title="延期の選択肢" unit="回" items={POSTPONE_OPTIONS.map((k) => ({ key: k, label: POSTPONE_LABEL[k], count: r.postpone.options[k] }))} />
          <h3 className="mt-3 text-sm font-bold">延期の理由</h3>
          <CountBars title="延期の理由" unit="回" items={REASON_KEYS.map((k) => ({ key: k, label: reasonLabel(k), count: r.postpone.reasons[k] }))} />
          <DataTable
            caption="延期の内訳"
            head={["項目", "件数"]}
            rows={[
              ...POSTPONE_COUNT_KEYS.map((k) => [`延期 ${k === "3+" ? "3回以上" : `${k}回`}の予定`, r.postpone.countDist[k]]),
              ...POSTPONE_OPTIONS.map((k) => [`選択肢：${POSTPONE_LABEL[k]}`, r.postpone.options[k]]),
              ...REASON_KEYS.map((k) => [`理由：${reasonLabel(k)}`, r.postpone.reasons[k]]),
            ]}
          />
        </div>
      </Section>

      <Section title="見送り・未実施">
        <div className={card}>
          <p className="text-sm">
            見送り {r.failures.skipped} 件・未実施 {r.failures.missed} 件
          </p>
          <h3 className="mt-3 text-sm font-bold">理由（見送り＋未実施）</h3>
          <CountBars
            title="見送り・未実施の理由"
            items={REASON_KEYS.map((k) => ({ key: k, label: reasonLabel(k), count: r.failures.reasons.skipped[k] + r.failures.reasons.missed[k] }))}
          />
          <DataTable
            caption="見送り・未実施の理由"
            head={["理由", "見送り", "未実施"]}
            rows={REASON_KEYS.map((k) => [reasonLabel(k), r.failures.reasons.skipped[k], r.failures.reasons.missed[k]])}
          />
          {r.failures.combos.length > 0 && (
            <>
              <h3 className="mt-3 text-sm font-bold">見送り・未実施が多い曜日と時間帯</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {r.failures.combos.map((c) => (
                  <li key={`${c.weekday}-${c.band}`}>
                    {weekdayShort(c.weekday)}曜日・{TIME_BAND_LABEL[c.band]}：{c.failures} 件（確定した {c.total} 件のうち）
                    {c.total < 5 && <span className="ml-1 inline-block whitespace-nowrap rounded border border-border px-1 text-xs text-muted">参考値</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-2 text-xs text-muted">未実施は期限を過ぎて自動で確定したもので、理由は記録されていません（「理由なし」）。</p>
        </div>
      </Section>

      <Section title="ルーティンごと">
        {r.perRoutine.length === 0 ? (
          <p className="text-sm text-muted">対象のルーティンがありません。</p>
        ) : (
          <ul className="space-y-2">
            {r.perRoutine.map((p) => (
              <li key={p.routine.id} className={`${card} text-sm`}>
                <p className="font-bold break-words">
                  <Link href={`/routines/detail/?id=${p.routine.id}`} className="text-accent underline">
                    {p.routine.name}
                  </Link>
                  {p.routine.exclude_from_analytics && <span className="ml-1 text-xs font-normal text-muted">（テスト用）</span>}
                  {p.routine.archived_at && <span className="ml-1 text-xs font-normal text-muted">（アーカイブ済み）</span>}
                </p>
                <dl>
                  <Stat label="達成率（選んだ期間）">
                    <RateValue rate={p.rate} />
                  </Stat>
                  <Stat label="連続達成（今・最長）">
                    {p.streaks.current} 回・{p.streaks.longest} 回
                  </Stat>
                  <Stat label={`直近4週（${shortDate(p.trend.recent.from)}〜）`}>
                    <RateValue rate={p.trend.recent.rate} />
                  </Stat>
                  <Stat label={`その前の4週（${shortDate(p.trend.previous.from)}〜${shortDate(p.trend.previous.to)}）`}>
                    <RateValue rate={p.trend.previous.rate} />
                  </Stat>
                  <Stat label="直近4週の変化">{formatPoints(p.trend.diff)}</Stat>
                  <Stat label="開始の遅れ（中央値）">
                    <SampleValue s={p.delayMedian} format={formatMinutes} />
                  </Stat>
                  <Stat label="延期した予定の割合">
                    <RateValue rate={p.postponed} />
                  </Stat>
                </dl>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">連続達成は、予定のあった日だけで数えます（予定のない曜日は途切れません。見送り・未実施で途切れ、未確定は飛ばします）。</p>
      </Section>
    </div>
  );
}
