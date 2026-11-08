// Phase 2：予定の状態に合わせた通知ジョブの作成・取り消しと、送信側の関数（docs/phase2-plan.md 2〜3章・6章）
// 時刻は内部の関数（_create_routine・_claim_due_jobs など）に引数で渡して固定する。
// claim は全ユーザーのジョブを対象にするので、テストごとに新しい DB を作って互いに影響しないようにする。

import { beforeEach, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, createUser, errorOf, jst } from "./harness";

let db: PGlite;
let alice: string;
beforeEach(async () => {
  db = await createTestDb();
  alice = await createUser(db, "alice");
});

// 2026-11-10 は火曜日
const TUE = "2026-11-10";
const WED = "2026-11-11";
const at = (date: string, hm: string) => jst(`${date} ${hm}`);

type Job = {
  id: string;
  occurrence_id: string | null;
  kind: string;
  fire_at: string;
  expires_at: string;
  status: string;
  attempts: number;
  cancel_reason: string | null;
  sent_at: string | null;
};

async function createRoutine(user: string, now: string, start = "07:00", name = "朝のストレッチ"): Promise<string> {
  const r = await db.query<{ id: string }>(
    "select public._create_routine($1, $2::timestamptz, $3, null, '{1,2,3,4,5,6,7}', $4::time, 15, 10) as id",
    [user, now, name, start],
  );
  return r.rows[0]!.id;
}
async function occOn(routineId: string, date: string): Promise<{ id: string; status: string; next_remind_at: string | null }> {
  const r = await db.query<{ id: string; status: string; next_remind_at: string | null }>(
    "select id, status, next_remind_at::text from public.occurrences where routine_id = $1 and planned_date = $2",
    [routineId, date],
  );
  if (!r.rows[0]) throw new Error(`${date} の予定がありません`);
  return r.rows[0];
}
async function jobsOf(occId: string): Promise<Job[]> {
  const r = await db.query<Job>(
    `select id, occurrence_id, kind, fire_at::text, expires_at::text, status, attempts, cancel_reason, sent_at::text
       from public.notification_jobs where occurrence_id = $1 order by fire_at, kind`,
    [occId],
  );
  return r.rows;
}
const ts = async (v: string) => (await db.query<{ t: string }>("select $1::timestamptz::text as t", [v])).rows[0]!.t;
const claim = async (now: string) =>
  (await db.query<Job>("select id, occurrence_id, kind, fire_at::text, status, attempts from public._claim_due_jobs($1::timestamptz, 50)", [now])).rows;
const finish = (now: string, jobId: string, ok: boolean, err: string | null = null) =>
  db.query("select public._finish_job($1::timestamptz, $2, $3, $4)", [now, jobId, ok, err]);
const accepted = async (jobId: string, user: string) => {
  // 送信の記録（record_push_outcome が作る行の代わり）。受け付けた端末1台
  const s = await db.query<{ id: string }>(
    "insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://web.push.apple.com/' || gen_random_uuid(), repeat('B', 87), repeat('A', 22)) returning id",
    [user],
  );
  await db.query(
    "insert into public.notification_deliveries (job_id, subscription_id, user_id, ok, http_status) values ($1, $2, $3, true, 201)",
    [jobId, s.rows[0]!.id, user],
  );
};
const recordDone = (now: string, occ: string) =>
  db.query("select public._record_done($1, $2::timestamptz, $3, $2::timestamptz - interval '15 minutes', 15, 'now')", [alice, now, occ]);
const postpone = (now: string, occ: string, option: string, remindAt: string | null = null) =>
  db.query("select public._postpone($1, $2::timestamptz, $3, $4, $5::timestamptz, 'tired', null)", [alice, now, occ, option, remindAt]);

describe("予定に合わせて通知ジョブを作る", () => {
  test("登録すると、今日と明日の予定時刻に initial ジョブができる（期限は＋60分）", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    for (const d of [TUE, WED]) {
      const jobs = await jobsOf((await occOn(r, d)).id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ kind: "initial", status: "pending", fire_at: await ts(at(d, "07:00")), expires_at: await ts(at(d, "08:00")) });
    }
  });

  test("予定の作成を何度呼んでもジョブは重複しない", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    await db.query("select public._ensure_occurrences($1, $2::timestamptz)", [alice, at(TUE, "06:30")]);
    await db.query("select public._ensure_occurrences(null, $1::timestamptz)", [at(TUE, "06:40")]);
    expect(await jobsOf((await occOn(r, TUE)).id)).toHaveLength(1);
  });

  test("通知時刻を過ぎた予定には新しく作らない（反映時の作成も同じ規則）", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    const occ = await occOn(r, TUE);
    await db.query("delete from public.notification_jobs where occurrence_id = $1", [occ.id]);
    // 反映時と同じ処理を、予定時刻を過ぎた 07:01 に行う
    await db.query("select public._sync_occurrence_jobs(o, $1::timestamptz) from public.occurrences o where o.id = $2", [at(TUE, "07:01"), occ.id]);
    expect(await jobsOf(occ.id)).toEqual([]);
    // 未来の予定（明日）には作る
    await db.query("delete from public.notification_jobs where occurrence_id = $1", [(await occOn(r, WED)).id]);
    await db.query("select public._sync_occurrence_jobs(o, $1::timestamptz) from public.occurrences o where o.routine_id = $2", [at(TUE, "07:01"), r]);
    expect(await jobsOf((await occOn(r, WED)).id)).toHaveLength(1);
  });

  test("編集で予定時刻が変わると古いジョブを取り消して作り直し、元の時刻に戻すと同じ行を送信待ちに戻す", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    const edit = (now: string, start: string) =>
      db.query("select public._edit_routine($1, $2::timestamptz, $3, '朝のストレッチ', null, '{1,2,3,4,5,6,7}', $4::time, 15, 10, $5::date, '時刻変更')", [
        alice, now, r, start, TUE,
      ]);
    await edit(at(TUE, "06:10"), "07:30");
    const occ = await occOn(r, TUE);
    let jobs = await jobsOf(occ.id);
    expect(jobs.map((j) => [j.fire_at, j.status, j.cancel_reason])).toEqual([
      [await ts(at(TUE, "07:00")), "cancelled", "rescheduled"],
      [await ts(at(TUE, "07:30")), "pending", null],
    ]);
    await edit(at(TUE, "06:20"), "07:00");
    // 2回目の編集も反映される（edited イベントだけなら作り直す。20261108000200 の修正）
    jobs = await jobsOf((await occOn(r, TUE)).id);
    expect(jobs.map((j) => [j.fire_at, j.status, j.cancel_reason])).toEqual([
      [await ts(at(TUE, "07:00")), "pending", null],
      [await ts(at(TUE, "07:30")), "cancelled", "rescheduled"],
    ]);
  });

  test("延期すると予定時刻の通知を取り消して再通知を作る。延期し直すと古い再通知を取り消す", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"), "08:00");
    const occ = await occOn(r, TUE);
    await postpone(at(TUE, "06:00"), occ.id, "10m");
    await postpone(at(TUE, "06:05"), occ.id, "30m");
    const jobs = await jobsOf(occ.id);
    expect(jobs.map((j) => [j.kind, j.fire_at, j.status, j.cancel_reason])).toEqual([
      ["snooze", await ts(at(TUE, "06:10")), "cancelled", "superseded"],
      ["snooze", await ts(at(TUE, "06:35")), "pending", null],
      ["initial", await ts(at(TUE, "08:00")), "cancelled", "postponed"],
    ]);
    expect(jobs[1]!.expires_at).toBe(await ts(at(TUE, "07:35")));
  });

  test("完了・見送り・未実施・アーカイブで、送っていない通知をすべて取り消す（理由は closed）", async () => {
    const r1 = await createRoutine(alice, at(TUE, "06:00"), "07:00", "完了する");
    const r2 = await createRoutine(alice, at(TUE, "06:00"), "07:00", "見送る");
    const r3 = await createRoutine(alice, at(TUE, "06:00"), "07:00", "放置する");
    const r4 = await createRoutine(alice, at(TUE, "06:00"), "07:00", "アーカイブする");
    const o1 = await occOn(r1, TUE);
    await postpone(at(TUE, "06:00"), o1.id, "10m");
    await recordDone(at(TUE, "06:30"), o1.id);
    const o2 = await occOn(r2, TUE);
    await db.query("select public._skip($1, $2::timestamptz, $3, 'plans', null)", [alice, at(TUE, "06:30"), o2.id]);
    await db.query("select public._archive_routine($1, $2::timestamptz, $3)", [alice, at(TUE, "06:30"), r4]);
    await db.query("select public._close_missed($1, $2::timestamptz)", [alice, jst("2026-11-12 00:00")]);
    for (const occId of [o1.id, o2.id, (await occOn(r3, TUE)).id, (await occOn(r4, TUE)).id, (await occOn(r4, WED)).id]) {
      const jobs = await jobsOf(occId);
      expect(jobs.filter((j) => j.status === "pending")).toEqual([]);
      expect(jobs.some((j) => j.cancel_reason === "closed")).toBe(true);
    }
  });
});

describe("送信側：取り出し・結果・再試行", () => {
  test("時刻になったジョブだけを取り出し、2回目は取り出さない（二重送信の防止）", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    expect(await claim(at(TUE, "06:59"))).toEqual([]);
    const first = await claim(at(TUE, "07:00"));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ occurrence_id: (await occOn(r, TUE)).id, kind: "initial", status: "sending", attempts: 1 });
    expect(await claim(at(TUE, "07:01"))).toEqual([]);
  });

  test("期限（＋60分）を過ぎたジョブは送らずに expired にする", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    expect(await claim(at(TUE, "08:00"))).toEqual([]);
    expect((await jobsOf((await occOn(r, TUE)).id))[0]!.status).toBe("expired");
  });

  test("確定済みの予定・時刻のずれた通知は、期限内でも送らずに取り消す（トリガーを通らずに残った場合の守り）", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    const occ = await occOn(r, TUE);
    await recordDone(at(TUE, "06:50"), occ.id);
    // トリガーの取り消しを通らずに残ったジョブを想定して、直接作る
    await db.query(
      "insert into public.notification_jobs (user_id, occurrence_id, kind, fire_at, expires_at) values ($1, $2, 'snooze', $3::timestamptz, $3::timestamptz + interval '1 hour')",
      [alice, occ.id, at(TUE, "06:55")],
    );
    expect(await claim(at(TUE, "07:00"))).toEqual([]);
    const jobs = await jobsOf(occ.id);
    expect(jobs.find((j) => j.kind === "snooze")).toMatchObject({ status: "cancelled", cancel_reason: "stale" });
  });

  test("成功（Push サービスが受け付け）で sent。予定時刻の通知なら予定を「通知済み」にし、受け付けた端末数をイベントに残す", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    const occ = await occOn(r, TUE);
    const [job] = await claim(at(TUE, "07:00"));
    await accepted(job!.id, alice);
    await finish(at(TUE, "07:00:05"), job!.id, true);
    expect((await jobsOf(occ.id))[0]).toMatchObject({ status: "sent", sent_at: await ts(at(TUE, "07:00:05")) });
    expect((await occOn(r, TUE)).status).toBe("notified");
    const ev = await db.query<{ type: string; from_status: string; to_status: string; actor: string; detail: Record<string, unknown> }>(
      "select type, from_status, to_status, actor, detail from public.occurrence_events where occurrence_id = $1",
      [occ.id],
    );
    expect(ev.rows).toEqual([
      {
        type: "notified", from_status: "scheduled", to_status: "notified", actor: "system",
        detail: { kind: "initial", job_id: job!.id, fire_at: expect.any(String), attempts: 1, accepted_devices: 1 },
      },
    ]);
    // 通知済みでも記録・延期はできる。延期すると再通知ができる
    await postpone(at(TUE, "07:05"), occ.id, "10m");
    const snooze = (await jobsOf(occ.id)).find((j) => j.kind === "snooze")!;
    expect(snooze).toMatchObject({ status: "pending", fire_at: await ts(at(TUE, "07:15")) });
    // 再通知の成功では状態は延期中のまま、イベントだけ増える
    const [sj] = await claim(at(TUE, "07:15"));
    await accepted(sj!.id, alice);
    await finish(at(TUE, "07:15:03"), sj!.id, true);
    expect((await occOn(r, TUE)).status).toBe("postponed");
  });

  test("全端末で失敗したら failed。予定は「予定どおり」のまま", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    const [job] = await claim(at(TUE, "07:00"));
    await finish(at(TUE, "07:00:05"), job!.id, false, "all deliveries failed");
    expect((await jobsOf((await occOn(r, TUE)).id))[0]!.status).toBe("failed");
    expect((await occOn(r, TUE)).status).toBe("scheduled");
  });

  test("一時的な失敗は期限内で3回まで再送し（最初と合わせて4回）、それ以上はしない", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    const occ = await occOn(r, TUE);
    const retry = async (now: string, id: string) =>
      (await db.query<{ r: string }>("select public._retry_job($1::timestamptz, $2, 'HTTP 503') as r", [now, id])).rows[0]!.r;
    const [j1] = await claim(at(TUE, "07:00"));
    expect(await retry(at(TUE, "07:00:02"), j1!.id)).toBe("retry");
    const [j2] = await claim(at(TUE, "07:01"));
    expect(j2).toMatchObject({ id: j1!.id, attempts: 2 });
    expect(await retry(at(TUE, "07:01:02"), j2!.id)).toBe("retry");
    const [j3] = await claim(at(TUE, "07:02"));
    expect(j3!.attempts).toBe(3);
    expect(await retry(at(TUE, "07:02:02"), j3!.id)).toBe("retry");
    const [j4] = await claim(at(TUE, "07:03"));
    expect(j4!.attempts).toBe(4);
    expect(await retry(at(TUE, "07:03:02"), j4!.id)).toBe("failed");
    expect(await claim(at(TUE, "07:04"))).toEqual([]);
    expect((await jobsOf(occ.id))[0]).toMatchObject({ status: "failed", attempts: 4 });
  });

  test("期限を過ぎていたら、回数が残っていても再送しない", async () => {
    await createRoutine(alice, at(TUE, "06:00"));
    const [j] = await claim(at(TUE, "07:59"));
    const r = await db.query<{ r: string }>("select public._retry_job($1::timestamptz, $2, 'HTTP 503') as r", [at(TUE, "08:00"), j!.id]);
    expect(r.rows[0]!.r).toBe("failed");
  });

  test("送信途中で止まったジョブ（5分以上 sending）は送信待ちに戻す", async () => {
    await createRoutine(alice, at(TUE, "06:00"));
    const [j] = await claim(at(TUE, "07:00"));
    expect(await claim(at(TUE, "07:04"))).toEqual([]);
    const again = await claim(at(TUE, "07:06"));
    expect(again).toEqual([expect.objectContaining({ id: j!.id, attempts: 2 })]);
  });

  test("文面用の情報：予定を作った版の名前・予定時刻・所要時間・延期回数と、送ってよいか", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    const occ = await occOn(r, TUE);
    const [job] = await claim(at(TUE, "07:00"));
    const p = await db.query("select job_id, occurrence_id, kind, routine_name, planned_duration_min, postpone_count, occurrence_status, still_due from public.job_payloads($1)", [[job!.id]]);
    expect(p.rows).toEqual([
      { job_id: job!.id, occurrence_id: occ.id, kind: "initial", routine_name: "朝のストレッチ", planned_duration_min: 15, postpone_count: 0, occurrence_status: "scheduled", still_due: true },
    ]);
  });
});

describe("完了・見送りと送信が重なったとき", () => {
  test("取り出した後に完了したら、送る直前の確認で送らずに取り消す", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    const occ = await occOn(r, TUE);
    const [job] = await claim(at(TUE, "07:00"));
    await recordDone(at(TUE, "07:00:01"), occ.id);
    const p = await db.query<{ still_due: boolean }>("select still_due from public.job_payloads($1)", [[job!.id]]);
    expect(p.rows[0]!.still_due).toBe(false);
    await db.query("select public._cancel_job($1::timestamptz, $2)", [at(TUE, "07:00:02"), job!.id]);
    expect((await jobsOf(occ.id))[0]).toMatchObject({ status: "cancelled", cancel_reason: "stale" });
    expect((await occOn(r, TUE)).status).toBe("done");
  });

  test("送った直後に見送りが確定していた場合：予定は見送りのまま、通知の事実だけをイベントに残す", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    const occ = await occOn(r, TUE);
    const [job] = await claim(at(TUE, "07:00"));
    await accepted(job!.id, alice);
    await db.query("select public._skip($1, $2::timestamptz, $3, 'plans', null)", [alice, at(TUE, "07:00:01"), occ.id]);
    await finish(at(TUE, "07:00:02"), job!.id, true);
    expect((await occOn(r, TUE)).status).toBe("skipped");
    const ev = await db.query<{ type: string; from_status: string; to_status: string }>(
      "select type, from_status, to_status from public.occurrence_events where occurrence_id = $1 order by id",
      [occ.id],
    );
    expect(ev.rows.map((e) => [e.type, e.from_status, e.to_status])).toEqual([
      ["skipped", "scheduled", "skipped"],
      ["notified", "skipped", "skipped"],
    ]);
  });

  test("通知済みの後に完了しても、記録はそのまま成功する", async () => {
    const r = await createRoutine(alice, at(TUE, "06:00"));
    const occ = await occOn(r, TUE);
    const [job] = await claim(at(TUE, "07:00"));
    await finish(at(TUE, "07:00:02"), job!.id, true);
    await recordDone(at(TUE, "07:20"), occ.id);
    expect((await occOn(r, TUE)).status).toBe("done");
  });
});

describe("権限", () => {
  test("自分の通知ジョブだけが見え、送信用・内部の関数は画面から使えない", async () => {
    const bob = await createUser(db, "bob");
    await createRoutine(alice, at(TUE, "06:00"));
    const mine = await as(db, "authenticated", alice, (tx) => tx.query("select id from public.notification_jobs"));
    expect(mine.rows).toHaveLength(2);
    const others = await as(db, "authenticated", bob, (tx) => tx.query("select id from public.notification_jobs"));
    expect(others.rows).toEqual([]);
    for (const role of ["anon", "authenticated"] as const) {
      for (const sql of [
        "select public.claim_due_jobs(10)",
        "select public.finish_job(gen_random_uuid(), true, null)",
        "select public.retry_job(gen_random_uuid(), null)",
        "select public.cancel_job(gen_random_uuid())",
        "select * from public.job_payloads('{}')",
        "select public._claim_due_jobs(now(), 10)",
        "select public._sync_occurrence_jobs(o, now()) from public.occurrences o",
      ]) {
        expect(await errorOf(as(db, role, role === "anon" ? null : bob, (tx) => tx.query(sql)))).toMatch(/permission denied/);
      }
      expect(
        await errorOf(as(db, role, role === "anon" ? null : bob, (tx) => tx.query("update public.notification_jobs set status = 'pending'"))),
      ).toMatch(/permission denied/);
    }
  });

  test("Phase 0 のテスト通知のジョブは、これまでどおり取り出して送れる", async () => {
    const j = await db.query<{ id: string }>("select public.schedule_test_push($1, 60) as id", [alice]);
    const got = await db.query<{ id: string; kind: string }>(
      "select id, kind from public._claim_due_jobs(now() + interval '2 minutes', 50)",
    );
    expect(got.rows).toEqual([{ id: j.rows[0]!.id, kind: "test" }]);
    await finish(new Date().toISOString(), j.rows[0]!.id, true);
    const s = await db.query<{ status: string }>("select status from public.notification_jobs where id = $1", [j.rows[0]!.id]);
    expect(s.rows[0]!.status).toBe("sent");
  });
});
