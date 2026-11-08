// send-push の本体（docs/phase2-plan.md 4章）。DB と HTTP は引数で受け取り、Node の単体テストでは偽物に差し替える。
//
// 1. 送る時刻になったジョブを取り出す（claim_due_jobs：二重送信の防止・期限切れ・確定済みの予定の取り消しは DB 側）
// 2. 予定の通知は、送る直前に予定の情報を取り直し、確定済み・時刻のずれたものは送らずに取り消す（cancel_job）
// 3. 本人の有効な端末すべてに送り、端末ごとの結果を記録する（deliverToUser → record_push_outcome）
// 4. 1台以上の Push サービスが受け付けたら成功（finish_job）。受け付け＝端末での表示ではない（判断事項2）
//    1台も受け付けず、5xx・429・通信エラーがあれば期限内で最大3回まで再送（retry_job）。
//    受け付けた端末があるジョブは再送しないので、同じ端末に重ねて送ることはない（判断事項3）
//
// 後方互換：DB が Phase 1 のまま（retry_job / cancel_job / job_payloads がない）でも、test の通知は今までどおり送れる。

import { deliverToUser, summarize, type DeliveryOutcome, type DeliveryStore, type Sender } from "./deliver.ts";
import { occurrencePayload, testPayload, type NotificationPayload, type OccurrenceInfo } from "./payload.ts";
import type { VapidKeys } from "./webpush.ts";

export type Job = {
  id: string;
  user_id: string;
  occurrence_id: string | null;
  kind: "test" | "initial" | "snooze";
  fire_at: string;
  expires_at: string;
  attempts: number;
};

export type JobPayloadRow = OccurrenceInfo & { job_id: string; still_due: boolean };

export interface DispatchDb {
  claim(limit: number): Promise<Job[]>;
  payloads(jobIds: string[]): Promise<JobPayloadRow[]>;
  finish(jobId: string, ok: boolean, error: string | null): Promise<void>;
  /** 'retry'（送信待ちに戻した）か 'failed'（回数・期限の上限） */
  retry(jobId: string, error: string): Promise<string>;
  cancel(jobId: string): Promise<void>;
}

export type DispatchResult = { jobs: number; sent: number; failed: number; retried: number; cancelled: number };

/** 一時的な失敗か（再送する価値がある）：通信エラー・429・5xx。404/410 は端末を無効にし、その他の 4xx は再送しない */
export function isTransient(o: DeliveryOutcome): boolean {
  if (o.ok || o.disabled) return false;
  return o.status === null || o.status === 429 || o.status >= 500;
}

export type JobDecision = { action: "finish"; ok: boolean; error: string | null } | { action: "retry"; error: string };

/** 端末ごとの結果から、ジョブをどうするかを決める */
export function decideJob(outcomes: DeliveryOutcome[]): JobDecision {
  const s = summarize(outcomes);
  if (s.sent > 0) return { action: "finish", ok: true, error: null };
  if (s.devices === 0) return { action: "finish", ok: false, error: "no active subscription" };
  const transient = outcomes.filter(isTransient);
  if (transient.length > 0) {
    const first = transient[0]!;
    return { action: "retry", error: first.status === null ? "network error" : `HTTP ${first.status}` };
  }
  return { action: "finish", ok: false, error: "all deliveries failed" };
}

/** 通知の有効期間（秒）：期限までの残り。届かないまま期限を過ぎたものは Push サービス側でも捨てる */
export function ttlFor(job: Job, now: Date): number {
  const left = Math.floor((new Date(job.expires_at).getTime() - now.getTime()) / 1000);
  return Math.max(60, Math.min(left, 3600));
}

export async function dispatchDueJobs(params: {
  db: DispatchDb;
  store: DeliveryStore;
  vapid: VapidKeys;
  send: Sender;
  now?: () => Date;
  limit?: number;
  allowEndpoint?: (endpoint: string) => boolean;
}): Promise<DispatchResult> {
  const now = params.now ?? (() => new Date());
  const jobs = await params.db.claim(params.limit ?? 50);
  const result: DispatchResult = { jobs: jobs.length, sent: 0, failed: 0, retried: 0, cancelled: 0 };
  if (jobs.length === 0) return result;

  const occJobs = jobs.filter((j) => j.kind !== "test");
  const infoByJob = new Map<string, JobPayloadRow>();
  if (occJobs.length > 0) {
    for (const row of await params.db.payloads(occJobs.map((j) => j.id))) infoByJob.set(row.job_id, row);
  }

  for (const job of jobs) {
    let payload: NotificationPayload;
    if (job.kind === "test") {
      payload = testPayload(job.id, now());
    } else {
      const info = infoByJob.get(job.id);
      if (!info || !info.still_due) {
        // 取り出した後に完了・見送り・延期し直しなどがあった：送らない
        await params.db.cancel(job.id);
        result.cancelled++;
        continue;
      }
      payload = occurrencePayload(info, now());
    }

    const outcomes = await deliverToUser({
      userId: job.user_id,
      jobId: job.id,
      payload,
      vapid: params.vapid,
      store: params.store,
      send: params.send,
      ttlSeconds: ttlFor(job, now()),
      // Topic は32文字まで。予定 ID（UUID）のハイフンを除くとちょうど32文字で、途中で切れて別の予定と重ならない
      topic: job.kind === "test" ? undefined : payload.tag.replace(/-/g, ""),
      allowEndpoint: params.allowEndpoint,
    });
    const decision = decideJob(outcomes);
    if (decision.action === "retry") {
      let r: string;
      try {
        r = await params.db.retry(job.id, decision.error);
      } catch {
        // retry_job がない（DB が Phase 1 のまま）：今までどおり失敗として記録する
        await params.db.finish(job.id, false, decision.error);
        r = "failed";
      }
      if (r === "retry") result.retried++;
      else result.failed++;
      continue;
    }
    await params.db.finish(job.id, decision.ok, decision.error);
    if (decision.ok) result.sent++;
    else result.failed++;
  }
  return result;
}
