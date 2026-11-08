// 分析画面の小さなグラフ（自作の SVG。ライブラリなし）。
// - 色は1色（アクセント）だけ。区別は色ではなく文字で示す（値・件数・「参考値」を棒の横に書く）
// - 5件未満（参考値）の棒は薄く塗り、文字でも「参考」と書く。0件は棒を描かず「データなし」
// - 棒は太さ 24px まで、先端だけ角丸。値の文字は本文の色（データの色にしない）
// - グラフには必ず同じ数値の表を添える（要件 NF-07）。グラフ自体は読み上げでは1つの画像として扱う
import { formatRate, type Rate } from "@/lib/analytics/stats";

const REF_OPACITY = 0.45;

/** 先端（右または上）だけ角を丸めた棒の path */
function barPath(x: number, y: number, w: number, h: number, dir: "right" | "up", r = 4): string {
  if (w <= 0 || h <= 0) return "";
  const rr = Math.min(r, dir === "right" ? w : h, dir === "right" ? h / 2 : w / 2);
  if (dir === "right") {
    return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
  }
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

export type RateItem = { key: string; label: string; rate: Rate };

/** 横棒：区分ごとの達成率（曜日別・時間帯別・ルーティン別）。棒の右に「67%（2/3件）」 */
export function RateBars({ items, title }: { items: RateItem[]; title: string }) {
  const rowH = 32;
  const labelW = 112;
  const barMax = 120;
  const width = labelW + barMax + 130;
  const height = items.length * rowH;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`${title}（数値は下の表）`}>
      {items.map((it, i) => {
        const y = i * rowH;
        // 0% も 2px の棒を描く（「データなし」＝棒なし と見分けるため）
        const w = it.rate.rate === null ? 0 : Math.max(it.rate.rate * barMax, 2);
        const text = it.rate.rate === null ? "データなし" : `${formatRate(it.rate)}${it.rate.reference ? " 参考" : ""}`;
        return (
          <g key={it.key}>
            <title>{`${it.label}：${text}`}</title>
            <text x={0} y={y + rowH / 2} dominantBaseline="middle" className="fill-foreground text-[12px]">
              {it.label}
            </text>
            <line x1={labelW} x2={labelW} y1={y + 4} y2={y + rowH - 4} className="stroke-border" strokeWidth={1} />
            {w > 0 && (
              <path
                d={barPath(labelW, y + (rowH - 16) / 2, w, 16, "right")}
                className="fill-accent"
                opacity={it.rate.reference ? REF_OPACITY : 1}
              />
            )}
            <text x={labelW + w + 6} y={y + rowH / 2} dominantBaseline="middle" className={`text-[12px] ${it.rate.rate === null ? "fill-muted" : "fill-foreground"}`}>
              {text}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** 縦棒：日別・週別の達成率の推移。0%・50%・100% の補助線。棒の上には値を書かない（数が多いため。表で示す） */
export function RateColumns({ items, title }: { items: RateItem[]; title: string }) {
  const height = 140;
  const top = 8;
  const bottom = 22;
  const left = 34;
  const plotH = height - top - bottom;
  // 幅を固定して、項目の数が違っても文字の大きさをそろえる
  const width = 340;
  const slot = (width - left - 4) / Math.max(items.length, 1);
  const barW = Math.min(24, slot * 0.7);
  const every = Math.ceil(items.length / 7); // 軸の日付は最大7つ程度
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`${title}（数値は下の表）`}>
      {[0, 0.5, 1].map((g) => (
        <g key={g}>
          <line x1={left} x2={width} y1={top + plotH * (1 - g)} y2={top + plotH * (1 - g)} className="stroke-border" strokeWidth={1} />
          <text x={left - 4} y={top + plotH * (1 - g)} textAnchor="end" dominantBaseline="middle" className="fill-muted text-[10px]">
            {g * 100}%
          </text>
        </g>
      ))}
      {items.map((it, i) => {
        const cx = left + slot * i + slot / 2;
        const h = it.rate.rate === null ? 0 : Math.max(it.rate.rate * plotH, 2);
        const text = it.rate.rate === null ? "データなし" : `${formatRate(it.rate)}${it.rate.reference ? " 参考" : ""}`;
        return (
          <g key={it.key}>
            <title>{`${it.label}：${text}`}</title>
            {/* 触れる範囲は棒より広く（区分の幅いっぱい） */}
            <rect x={cx - slot / 2} y={top} width={slot} height={plotH} fill="transparent" />
            {h > 0 && (
              <path
                d={barPath(cx - barW / 2, top + plotH - h, barW, h, "up")}
                className="fill-accent"
                opacity={it.rate.reference ? REF_OPACITY : 1}
              />
            )}
            {it.rate.rate === null && (
              <text x={cx} y={top + plotH - 4} textAnchor="middle" className="fill-muted text-[9px]">
                ―
              </text>
            )}
            {i % every === 0 && (
              <text x={cx} y={height - 6} textAnchor="middle" className="fill-muted text-[10px]">
                {it.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export type CountItem = { key: string; label: string; count: number };

/** 横棒：件数の内訳（遅延の分布・理由・延期の選択肢）。最大値を棒の長さの基準にする */
export function CountBars({ items, title, unit = "件" }: { items: CountItem[]; title: string; unit?: string }) {
  const rowH = 28;
  const labelW = 124;
  const barMax = 130;
  const width = labelW + barMax + 60;
  const height = items.length * rowH;
  const max = Math.max(1, ...items.map((x) => x.count));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`${title}（数値は下の表）`}>
      {items.map((it, i) => {
        const y = i * rowH;
        const w = (it.count / max) * barMax;
        return (
          <g key={it.key}>
            <title>{`${it.label}：${it.count}${unit}`}</title>
            <text x={0} y={y + rowH / 2} dominantBaseline="middle" className="fill-foreground text-[12px]">
              {it.label}
            </text>
            <line x1={labelW} x2={labelW} y1={y + 4} y2={y + rowH - 4} className="stroke-border" strokeWidth={1} />
            {w > 0 && <path d={barPath(labelW, y + (rowH - 14) / 2, w, 14, "right")} className="fill-accent" />}
            <text x={labelW + w + 6} y={y + rowH / 2} dominantBaseline="middle" className="fill-foreground text-[12px]">
              {it.count}
              {unit}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
