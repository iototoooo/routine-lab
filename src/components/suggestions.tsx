// 改善提案の表示部品（一覧・確認画面・ルーティン詳細で共通）。
// 根拠は必ず「期間・件数・数値」を文字で示す。R-02 は少ない件数による傾向なので「参考傾向」と明示する。
import { formatRate, rate } from "@/lib/analytics/stats";
import { formatDuration, formatWeekdays } from "@/lib/domain/routine";
import { RULE_TITLE, type PlanSettings, type RuleId, type Suggestion } from "@/lib/suggestions/rules";
import { formatDateShort, weekdayShort } from "@/lib/time/jst";

const tag = "ml-1 inline-block whitespace-nowrap rounded border border-border px-1 text-xs text-muted";

export function ruleTitle(ruleId: string): string {
  return RULE_TITLE[ruleId as RuleId] ?? ruleId;
}

/** 変えた項目だけを「変更前 → 変更後」で並べる */
export function settingChanges(cur: PlanSettings, next: PlanSettings): { label: string; before: string; after: string }[] {
  const out: { label: string; before: string; after: string }[] = [];
  if (cur.weekdays.join() !== next.weekdays.join()) out.push({ label: "曜日", before: formatWeekdays(cur.weekdays), after: formatWeekdays(next.weekdays) });
  if (cur.start_time !== next.start_time) out.push({ label: "開始時刻", before: cur.start_time, after: next.start_time });
  if (cur.duration_min !== next.duration_min) out.push({ label: "所要時間", before: formatDuration(cur.duration_min), after: formatDuration(next.duration_min) });
  return out;
}

export function SettingsDiff({ current, proposed, caption }: { current: PlanSettings; proposed: PlanSettings; caption: string }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-left text-muted">
          <th className="py-1 pr-2 font-normal">項目</th>
          <th className="py-1 pr-2 font-normal">今の設定</th>
          <th className="py-1 font-normal">提案</th>
        </tr>
      </thead>
      <tbody>
        {settingChanges(current, proposed).map((c) => (
          <tr key={c.label} className="border-t border-border align-top">
            <th className="py-2 pr-2 text-left font-normal">{c.label}</th>
            <td className="py-2 pr-2">{c.before}</td>
            <td className="py-2 font-bold">{c.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 根拠（期間・件数・数値）。文で示す */
export function EvidenceView({ s }: { s: Suggestion }) {
  const e = s.evidence;
  return (
    <div className="space-y-1 text-sm">
      <p className="text-muted">
        根拠：{formatDateShort(e.from)}〜{formatDateShort(e.to)}（直近 4 週・第{e.versionNo}版の予定だけ）・確定した予定 {e.finals} 件・達成率{" "}
        {formatRate(rate(e.rate.num, e.rate.den))}
      </p>
      {e.rule === "R-01" && (
        <p>
          開始の遅れの中央値が <span className="font-bold">+{Math.round(e.medianDelay)}分</span>（実測・時刻指定の記録 {e.samples} 件）。開始時刻を{" "}
          {e.shiftMin} 分遅らせると、実際に始めている時刻に近づきます。
          {(e.plannedExcluded > 0 || e.lateDayExcluded > 0) && (
            <span className="block text-xs text-muted">
              「予定どおり」で記録した {e.plannedExcluded} 件（入力上の0分）と、翌日以降に実施した {e.lateDayExcluded} 件は計算に入れていません。
            </span>
          )}
        </p>
      )}
      {e.rule === "R-02" && (
        <p>
          {weekdayShort(e.weekday)}曜日の達成率は <span className="font-bold">{formatRate(rate(e.day.num, e.day.den))}</span>、ほかの曜日をまとめると{" "}
          {formatRate(rate(e.others.num, e.others.den))}（差 {e.gapPoints} ポイント）。
          <span className={tag}>参考傾向</span>
          <span className="block text-xs text-muted">
            1 つの曜日は 4 週で最大 4 回のため、少ない件数からの傾向です。たまたまの可能性もあります。
          </span>
        </p>
      )}
      {e.rule === "R-03" && (
        <p>
          実際の所要時間の中央値は <span className="font-bold">{formatDuration(Math.round(e.medianActual))}</span>（予定の {e.medianRatio} 倍、完了 {e.samples} 件）。
        </p>
      )}
    </div>
  );
}
