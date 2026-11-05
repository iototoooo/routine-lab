import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import webpushLib from "web-push";
import {
  deliverToUser,
  summarize,
  type DeliveryOutcome,
  type DeliveryStore,
  type Sender,
  type Subscription,
} from "../../supabase/functions/_shared/deliver.ts";
import { testPayload } from "../../supabase/functions/_shared/payload.ts";

function sub(id: string, host: string): Subscription {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    id,
    endpoint: `https://${host}/push/${id}`,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
}

function fakeStore(subs: Subscription[]) {
  const recorded: { jobId: string | null; outcome: DeliveryOutcome }[] = [];
  const asked: string[] = [];
  const store: DeliveryStore = {
    async listActiveSubscriptions(userId) {
      asked.push(userId);
      return subs;
    },
    async recordOutcome(jobId, outcome) {
      recorded.push({ jobId, outcome });
    },
  };
  return { store, recorded, asked };
}

const keys = webpushLib.generateVAPIDKeys();
const vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:a@example.com" };

describe("deliverToUser", () => {
  it("本人の端末だけに送り、成功・失効（410/404）・失敗・通信エラーを記録する", async () => {
    const subs = [sub("ok", "a.example"), sub("gone", "b.example"), sub("nf", "c.example"), sub("err", "d.example"), sub("net", "e.example")];
    const { store, recorded, asked } = fakeStore(subs);
    const statusByHost: Record<string, number> = { "a.example": 201, "b.example": 410, "c.example": 404, "d.example": 500 };
    const sentTo: string[] = [];
    const send: Sender = async (req) => {
      const host = new URL(req.url).host;
      sentTo.push(host);
      if (host === "e.example") throw new Error("network down");
      return { status: statusByHost[host]!, text: async () => "server says no" };
    };

    const outcomes = await deliverToUser({
      userId: "user-1",
      jobId: "job-1",
      payload: testPayload("job-1", new Date("2026-11-05T00:00:00Z")),
      vapid,
      store,
      send,
      allowEndpoint: () => true,
    });

    expect(asked).toEqual(["user-1"]);
    expect(sentTo).toHaveLength(5);
    expect(recorded.every((r) => r.jobId === "job-1")).toBe(true);
    const byId = Object.fromEntries(outcomes.map((o) => [o.subscriptionId, o]));
    expect(byId.ok).toMatchObject({ ok: true, status: 201, disabled: false, error: null });
    expect(byId.gone).toMatchObject({ ok: false, status: 410, disabled: true });
    expect(byId.nf).toMatchObject({ ok: false, status: 404, disabled: true });
    expect(byId.err).toMatchObject({ ok: false, status: 500, disabled: false, error: "server says no" });
    expect(byId.net).toMatchObject({ ok: false, status: null, disabled: false, error: "network down" });
    expect(summarize(outcomes)).toEqual({ devices: 5, sent: 1, failed: 4, disabled: 2 });
  });

  it("端末がなければ何も送らない", async () => {
    const { store, recorded } = fakeStore([]);
    let called = 0;
    const outcomes = await deliverToUser({
      userId: "u",
      jobId: null,
      payload: testPayload("x", new Date()),
      vapid,
      store,
      send: async () => {
        called++;
        return { status: 201, text: async () => "" };
      },
    });
    expect(outcomes).toEqual([]);
    expect(called).toBe(0);
    expect(recorded).toEqual([]);
  });
});

describe("testPayload", () => {
  it("固定文面で、同じサイト内の記録画面を開き、tag はジョブごと", () => {
    const p = testPayload("abc", new Date("2026-11-04T22:30:00Z"));
    expect(p.title).toBe("Routine Lab テスト通知");
    expect(p.body).toContain("07:30");
    expect(p.tag).toBe("test-abc");
    expect(p.url).toBe("/record/?o=test-abc");
  });

  it("標準のプッシュサービス以外の endpoint には送らず無効にする（SSRF 対策）", async () => {
    const bad = { ...sub("evil", "attacker.example"), endpoint: "https://attacker.example/collect" };
    const { store, recorded } = fakeStore([bad]);
    let called = 0;
    const outcomes = await deliverToUser({
      userId: "u",
      jobId: null,
      payload: testPayload("x", new Date()),
      vapid,
      store,
      send: async () => {
        called++;
        return { status: 201, text: async () => "" };
      },
    });
    expect(called).toBe(0);
    expect(outcomes[0]).toMatchObject({ ok: false, disabled: true, error: "endpoint not allowed" });
    expect(recorded).toHaveLength(1);
  });
});
