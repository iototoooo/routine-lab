// 割合・中央値・平均と、件数の少なさの判定（要件 F-509：5件未満は参考値）。
// 割合には必ず分子と分母を持たせ、分母が0なら rate=null（＝「データなし」。0% にはしない）。

export const MIN_SAMPLE = 5;

export type Rate = {
  num: number;
  den: number;
  /** 0〜1。分母が0なら null（データなし） */
  rate: number | null;
  /** 1〜4件（参考値） */
  reference: boolean;
};

export function rate(num: number, den: number): Rate {
  return { num, den, rate: den === 0 ? null : num / den, reference: den > 0 && den < MIN_SAMPLE };
}

/** 中央値（偶数個なら中央2つの平均）。0件なら null */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 件数つきの値（中央値など） */
export type Sample = { n: number; value: number | null; reference: boolean };

export function sample(xs: readonly number[], f: (xs: readonly number[]) => number | null): Sample {
  return { n: xs.length, value: f(xs), reference: xs.length > 0 && xs.length < MIN_SAMPLE };
}

/** 2つの割合の差（ポイント）。どちらかがデータなしなら null */
export function diffPoints(a: Rate, b: Rate): number | null {
  return a.rate === null || b.rate === null ? null : (a.rate - b.rate) * 100;
}

/** 表示用：「67%（2/3件）」。データなしは「データなし」 */
export function formatRate(r: Rate): string {
  if (r.rate === null) return "データなし";
  return `${Math.round(r.rate * 100)}%（${r.num}/${r.den}件）`;
}

/** 表示用：差のポイント（+12pt / −5pt / ±0pt） */
export function formatPoints(p: number | null): string {
  if (p === null) return "—";
  const v = Math.round(p);
  if (v === 0) return "±0pt";
  return v > 0 ? `+${v}pt` : `−${-v}pt`;
}

/** 表示用：分（+12分 / −3分 / 0分） */
export function formatMinutes(m: number | null): string {
  if (m === null) return "データなし";
  const v = Math.round(m);
  if (v === 0) return "0分";
  return v > 0 ? `+${v}分` : `−${-v}分`;
}

/** キーごとに件数を数える（全キーを 0 で用意する） */
export function countBy<K extends string>(keys: readonly K[], items: readonly K[]): Record<K, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const k of items) out[k] += 1;
  return out;
}
