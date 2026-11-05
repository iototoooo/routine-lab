// 1人のユーザーのすべての有効な端末へ通知を送り、結果を記録する。
// DB と HTTP は引数で受け取り、単体テストでは偽物に差し替える。

import { buildPushRequest, type PushSubscriptionKeys, type VapidKeys } from "./webpush.ts";
import type { NotificationPayload } from "./payload.ts";
import { isAllowedPushEndpoint } from "./security.ts";

export type Subscription = PushSubscriptionKeys & { id: string };

export type DeliveryOutcome = {
  subscriptionId: string;
  ok: boolean;
  status: number | null; // HTTP ステータス（通信エラーは null）
  disabled: boolean; // 404 / 410 で無効にしたか
  error: string | null;
};

export interface DeliveryStore {
  listActiveSubscriptions(userId: string): Promise<Subscription[]>;
  recordOutcome(jobId: string | null, outcome: DeliveryOutcome): Promise<void>;
}

export type Sender = (req: {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}) => Promise<{ status: number; text(): Promise<string> }>;

export type DeliverySummary = {
  devices: number;
  sent: number;
  failed: number;
  disabled: number;
};

export function summarize(outcomes: DeliveryOutcome[]): DeliverySummary {
  return {
    devices: outcomes.length,
    sent: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    disabled: outcomes.filter((o) => o.disabled).length,
  };
}

export async function deliverToUser(params: {
  userId: string;
  jobId: string | null;
  payload: NotificationPayload;
  vapid: VapidKeys;
  store: DeliveryStore;
  send: Sender;
  ttlSeconds?: number;
  /** 送信先の検査（既定：標準プッシュサービスだけ。テストで差し替える） */
  allowEndpoint?: (endpoint: string) => boolean;
}): Promise<DeliveryOutcome[]> {
  const allow = params.allowEndpoint ?? isAllowedPushEndpoint;
  const subs = await params.store.listActiveSubscriptions(params.userId);
  const outcomes: DeliveryOutcome[] = [];
  for (const sub of subs) {
    let outcome: DeliveryOutcome;
    if (!allow(sub.endpoint)) {
      // 標準のプッシュサービス以外には送らず、端末を無効にする
      outcome = { subscriptionId: sub.id, ok: false, status: null, disabled: true, error: "endpoint not allowed" };
      await params.store.recordOutcome(params.jobId, outcome);
      outcomes.push(outcome);
      continue;
    }
    try {
      const req = await buildPushRequest(sub, params.payload, params.vapid, {
        ttlSeconds: params.ttlSeconds ?? 3600,
        topic: params.payload.tag,
      });
      const res = await params.send(req);
      const ok = res.status >= 200 && res.status < 300;
      const gone = res.status === 404 || res.status === 410;
      let error: string | null = null;
      if (!ok) error = (await res.text().catch(() => "")).slice(0, 200) || `HTTP ${res.status}`;
      outcome = { subscriptionId: sub.id, ok, status: res.status, disabled: gone, error };
    } catch (e) {
      outcome = {
        subscriptionId: sub.id,
        ok: false,
        status: null,
        disabled: false,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      };
    }
    await params.store.recordOutcome(params.jobId, outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}
