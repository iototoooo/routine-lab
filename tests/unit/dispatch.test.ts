// send-push の本体（_shared/dispatch.ts）と予定の通知の文面（_shared/payload.ts）。
// DB と Push サービスはどちらも偽物。本物の暗号化（buildPushRequest）は通す。
import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import webpushLib from "web-push";
import type { DeliveryOutcome, DeliveryStore, Sender, Subscription } from "../../supabase/functions/_shared/deliver.ts";
import {
  decideJob,
  dispatchDueJobs,
  isTransient,
  ttlFor,
  type DispatchDb,
  type Job,
  type JobPayloadRow,
} from "../../supabase/functions/_shared/dispatch.ts";
import { occurrencePayload } from "../../supabase/functions/_shared/payload.ts";

const keys = webpushLib.generateVAPIDKeys();
const vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:a@example.com" };
const NOW = new Date("2026-11-10T07:00:10+09:00");

function sub(id: string, host: string): Subscription {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { id, endpoint: `https://${host}/push/${id}`, p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

const OCC = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
function job(over: Partial<Job> = {}): Job {
  return {
    id: "job-1", user_id: "user-1", occurrence_id: OCC, kind: "initial",
    fire_at: "2026-11-09T22:00:00Z", expires_at: "2026-11-09T23:00:00Z", attempts: 1, ...over,
  };
}
function info(over: Partial<JobPayloadRow> = {}): JobPayloadRow {
  return {
    job_id: "job-1", occurrence_id: OCC, kind: "initial", routine_name: "朝のストレッチ",
    planned_start_at: "2026-11-09T22:00:00Z", planned_duration_min: 15, postpone_count: 0, still_due: true, ...over,
  };
}

/** 偽の DB：呼ばれた操作を記録する */
function fakeDb(jobs: Job[], rows: JobPayloadRow[], opts: { retryResult?: string; noRetryFn?: boolean } = {}) {
  const log: string[] = [];
  const db: DispatchDb = {
    async claim() {
      log.push("claim");
      return jobs;
    },
    async payloads(ids) {
      log.push(`payloads:${ids.join(",")}`);
      return rows.filter((r) => ids.includes(r.job_id));
    },
    async finish(id, ok, err) {
      log.push(`finish:${id}:${ok}:${err}`);
    },
    async retry(id, err) {
      if (opts.noRetryFn) throw new Error("retry_job failed: PGRST202");
      log.push(`retry:${id}:${err}`);
      return opts.retryResult ?? "retry";
    },
    async cancel(id) {
      log.push(`cancel:${id}`);
    },
  };
  return { db, log };
}

/** 偽の Push サービス：ホストごとに応答を決め、受け取った通知を記録する */
function fakePush(statusByHost: Record<string, number | "network">) {
  const received: { host: string; topic: string | undefined; ttl: string | undefined }[] = [];
  const send: Sender = async (req) => {
    const host = new URL(req.url).host;
    received.push({ host, topic: req.headers.Topic, ttl: req.headers.TTL });
    const s = statusByHost[host];
    if (s === "network") throw new Error("connect failed");
    return { status: s ?? 201, text: async () => "" };
  };
  return { send, received };
}

function fakeStore(subs: Subscription[]) {
  const recorded: { jobId: string | null; outcome: DeliveryOutcome }[] = [];
  const store: DeliveryStore = {
    async listActiveSubscriptions() {
      return subs;
    },
    async recordOutcome(jobId, outcome) {
      recorded.push({ jobId, outcome });
    },
  };
  return { store, recorded };
}

const allowAll = () => true;

describe("occurrencePayload（予定の通知の文面）", () => {
  it("予定時刻の通知：タイトルはルーティン名、本文は時刻と所要時間。tag と url は予定 ID", () => {
    expect(occurrencePayload(info(), NOW)).toEqual({
      title: "朝のストレッチ",
      body: "7:00〜 15分",
      tag: OCC,
      url: `/record/?o=${OCC}`,
    });
  });

  it("再通知：タイトルに「（再通知）」、本文に予定時刻と延期回数", () => {
    expect(occurrencePayload(info({ kind: "snooze", postpone_count: 2 }), NOW)).toMatchObject({
      title: "朝のストレッチ（再通知）",
      body: "予定 7:00〜 15分・延期2回目",
      tag: OCC,
    });
  });

  it("送る日と予定日が違う（0:00 をまたぐ・明日の同じ時刻）ときは予定日も入れる", () => {
    const late = info({ kind: "snooze", planned_start_at: "2026-11-10T14:30:00Z", postpone_count: 1 }); // 11/10（火）23:30 JST
    expect(occurrencePayload(late, new Date("2026-11-10T15:10:00Z")).body).toBe("予定 11/10（火）23:30〜 15分・延期1回目");
    expect(occurrencePayload(late, new Date("2026-11-10T14:40:00Z")).body).toBe("予定 23:30〜 15分・延期1回目");
  });
});

describe("decideJob / isTransient（受け付け・失効・一時的な失敗）", () => {
  const o = (status: number | null, ok = false, disabled = false): DeliveryOutcome => ({ subscriptionId: "s", ok, status, disabled, error: null });
  it("1台でも受け付けたら成功（他の端末の失敗では再送しない）", () => {
    expect(decideJob([o(201, true), o(503)])).toEqual({ action: "finish", ok: true, error: null });
  });
  it("受け付けなし・5xx / 429 / 通信エラーがあれば再送", () => {
    expect(decideJob([o(410, false, true), o(503)])).toEqual({ action: "retry", error: "HTTP 503" });
    expect(decideJob([o(null)])).toEqual({ action: "retry", error: "network error" });
    expect(isTransient(o(429))).toBe(true);
  });
  it("404 / 410 とその他の 4xx だけなら再送しない。端末がなければ失敗", () => {
    expect(decideJob([o(410, false, true), o(400)])).toEqual({ action: "finish", ok: false, error: "all deliveries failed" });
    expect(decideJob([])).toEqual({ action: "finish", ok: false, error: "no active subscription" });
    expect(isTransient(o(404, false, true))).toBe(false);
  });
  it("Push サービスでの保存期間は期限までの残り（60秒〜1時間）", () => {
    expect(ttlFor(job({ expires_at: "2026-11-09T23:00:00Z" }), NOW)).toBe(3590);
    expect(ttlFor(job({ expires_at: "2026-11-09T22:00:30Z" }), NOW)).toBe(60);
  });
});

describe("dispatchDueJobs（偽の DB と偽の Push サービス）", () => {
  it("予定の通知を全端末に送り、tag（Topic）を予定 ID にして、1台以上受け付けたら finish(ok)", async () => {
    const { db, log } = fakeDb([job()], [info()]);
    const { store, recorded } = fakeStore([sub("iphone", "web.push.apple.com"), sub("pc", "wns2.notify.windows.com")]);
    const { send, received } = fakePush({ "wns2.notify.windows.com": 410 });
    const r = await dispatchDueJobs({ db, store, vapid, send, now: () => NOW, allowEndpoint: allowAll });
    expect(r).toEqual({ jobs: 1, sent: 1, failed: 0, retried: 0, cancelled: 0 });
    expect(log).toEqual(["claim", "payloads:job-1", "finish:job-1:true:null"]);
    expect(received.map((x) => x.topic)).toEqual([OCC.replace(/-/g, ""), OCC.replace(/-/g, "")]);
    expect(recorded.map((x) => [x.outcome.subscriptionId, x.outcome.status, x.outcome.disabled])).toEqual([
      ["iphone", 201, false],
      ["pc", 410, true],
    ]);
  });

  it("取り出した後に予定が確定していたら（still_due=false）送らずに取り消す", async () => {
    const { db, log } = fakeDb([job()], [info({ still_due: false })]);
    const { store } = fakeStore([sub("iphone", "web.push.apple.com")]);
    const { send, received } = fakePush({});
    const r = await dispatchDueJobs({ db, store, vapid, send, now: () => NOW, allowEndpoint: allowAll });
    expect(r.cancelled).toBe(1);
    expect(received).toEqual([]);
    expect(log).toEqual(["claim", "payloads:job-1", "cancel:job-1"]);
  });

  it("予定の情報が見つからないジョブも送らない", async () => {
    const { db, log } = fakeDb([job()], []);
    const { send, received } = fakePush({});
    await dispatchDueJobs({ db, store: fakeStore([sub("a", "web.push.apple.com")]).store, vapid, send, now: () => NOW, allowEndpoint: allowAll });
    expect(received).toEqual([]);
    expect(log).toContain("cancel:job-1");
  });

  it("全端末が一時的な失敗なら retry を依頼する（上限なら failed として数える）", async () => {
    const subs = [sub("a", "web.push.apple.com")];
    const first = fakeDb([job()], [info()]);
    const r1 = await dispatchDueJobs({ db: first.db, store: fakeStore(subs).store, vapid, send: fakePush({ "web.push.apple.com": 503 }).send, now: () => NOW, allowEndpoint: allowAll });
    expect(r1.retried).toBe(1);
    expect(first.log).toContain("retry:job-1:HTTP 503");
    const last = fakeDb([job({ attempts: 4 })], [info()], { retryResult: "failed" });
    const r2 = await dispatchDueJobs({ db: last.db, store: fakeStore(subs).store, vapid, send: fakePush({ "web.push.apple.com": "network" }).send, now: () => NOW, allowEndpoint: allowAll });
    expect(r2).toMatchObject({ retried: 0, failed: 1 });
  });

  it("DB が Phase 1 のまま（retry_job がない）でも、テスト通知は今までどおり送れ、失敗は failed で記録する", async () => {
    const t = job({ id: "t1", kind: "test", occurrence_id: null });
    const ok = fakeDb([t], []);
    const r = await dispatchDueJobs({ db: ok.db, store: fakeStore([sub("a", "web.push.apple.com")]).store, vapid, send: fakePush({}).send, now: () => NOW, allowEndpoint: allowAll });
    expect(r.sent).toBe(1);
    expect(ok.log).toEqual(["claim", "finish:t1:true:null"]); // test だけなら job_payloads は呼ばない
    const ng = fakeDb([t], [], { noRetryFn: true });
    await dispatchDueJobs({ db: ng.db, store: fakeStore([sub("a", "web.push.apple.com")]).store, vapid, send: fakePush({ "web.push.apple.com": 500 }).send, now: () => NOW, allowEndpoint: allowAll });
    expect(ng.log).toEqual(["claim", "finish:t1:false:HTTP 500"]);
  });

  it("送るジョブがなければ何もしない", async () => {
    const { db, log } = fakeDb([], []);
    const r = await dispatchDueJobs({ db, store: fakeStore([]).store, vapid, send: fakePush({}).send, now: () => NOW });
    expect(r).toEqual({ jobs: 0, sent: 0, failed: 0, retried: 0, cancelled: 0 });
    expect(log).toEqual(["claim"]);
  });
});
