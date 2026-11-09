// 改善提案のしきい値（要件 6.2 節・docs/phase4-plan.md 2章）。あとで調整できるよう、ここにまとめる。
// DB（20261110000000_phase4_suggestions.sql）が守るのは「変えてよい項目」と「28 日」だけで、数値の条件は画面側で判定する。

/** 判定に使う期間：昨日までの直近 28 日（今日の予定は確定していないことが多いため入れない） */
export const WINDOW_DAYS = 28;
/** どのルールも、今の版で確定した予定（完了・見送り・未実施）がこの件数以上のときだけ判定する */
export const MIN_FINAL = 5;
/** 却下・承認した日から、同じルーティン・同じルールを出さない日数（JST の日付で数える） */
export const SUPPRESS_DAYS = 28;

/** R-01 慢性的な遅れ：遅れの中央値（実測・時刻指定だけ、翌日以降の実施を除く）がこの分以上 */
export const R01_MIN_DELAY_MIN = 20;
/** R-01：遅れを計算できる記録がこの件数以上 */
export const R01_MIN_SAMPLES = 5;
/** R-01：開始時刻をずらす幅の単位（分） */
export const R01_STEP_MIN = 15;

/** R-02 特定の曜日の不調：その曜日の達成率がこれ未満 */
export const R02_MAX_RATE = 0.4;
/** R-02：ほかの曜日（まとめた達成率）との差がこのポイント以上 */
export const R02_MIN_GAP_POINTS = 30;
/** R-02：その曜日と、ほかの曜日それぞれで、確定した予定がこの件数以上（4 週では1つの曜日は最大 4 回のため。判断事項 3） */
export const R02_MIN_DAY_FINAL = 3;

/** R-03 所要時間の不足：実際÷予定 の中央値がこれ以上 */
export const R03_MIN_RATIO = 1.3;
/** R-03：所要時間のある完了がこの件数以上 */
export const R03_MIN_SAMPLES = 5;
/** R-03：提案する所要時間の単位（分、切り上げ） */
export const R03_STEP_MIN = 5;
/** 所要時間の上限（DB の制約と同じ） */
export const DURATION_MAX = 480;
