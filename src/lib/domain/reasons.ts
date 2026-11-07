// 延期・見送り・未実施の理由（要件 F-408）。
// DB の check 制約（occurrence_events.reason_code）と同じ一覧。tests/db で一致を確認している。

export const REASON_CODES = ["no_time", "tired", "forgot", "plans", "sick", "unmotivated", "other"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_LABEL: Record<ReasonCode, string> = {
  no_time: "時間がなかった",
  tired: "疲れていた",
  forgot: "忘れていた",
  plans: "予定が入った",
  sick: "体調不良",
  unmotivated: "気分が乗らなかった",
  other: "その他",
};

export function isReasonCode(v: unknown): v is ReasonCode {
  return typeof v === "string" && (REASON_CODES as readonly string[]).includes(v);
}

export const REASON_TEXT_MAX = 500;
