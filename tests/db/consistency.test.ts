// 画面側（TypeScript）と DB 側（SQL）で同じ規則になっているか（二重に持つ定義のずれを防ぐ）

import { beforeAll, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, createUser, jst } from "./harness";
import { REASON_CODES } from "@/lib/domain/reasons";
import { POSTPONE_OPTIONS, remindAtFor } from "@/lib/domain/postpone";
import { OCCURRENCE_STATUSES } from "@/lib/domain/status";
import { CANCEL_REASONS, JOB_STATUSES } from "@/lib/domain/notify";
import { occurrenceDeadline } from "@/lib/time/jst";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});

async function checkDef(table: string, column: string): Promise<string> {
  const r = await db.query<{ def: string }>(
    `select pg_get_constraintdef(c.oid) as def from pg_constraint c
      where c.conrelid = $1::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like $2 || '%'`,
    [table, `CHECK ((${column} = ANY`],
  );
  return r.rows.map((x) => x.def).join("\n");
}
const listIn = (def: string) => [...def.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);

test("理由コード・延期の選択肢・予定の状態の一覧が DB と同じ", async () => {
  expect(listIn(await checkDef("public.occurrence_events", "reason_code"))).toEqual([...REASON_CODES]);
  expect(listIn(await checkDef("public.occurrence_events", "postpone_option"))).toEqual([...POSTPONE_OPTIONS]);
  expect(listIn(await checkDef("public.occurrences", "status"))).toEqual([...OCCURRENCE_STATUSES]);
});

test("通知ジョブの状態・取り消しの理由の一覧が DB と同じ", async () => {
  expect(listIn(await checkDef("public.notification_jobs", "status"))).toEqual([...JOB_STATUSES]);
  expect(listIn(await checkDef("public.notification_jobs", "cancel_reason"))).toEqual([...CANCEL_REASONS]);
});

test("記録の期限が DB と同じ", async () => {
  for (const d of ["2026-11-10", "2026-12-31", "2027-02-28"]) {
    const r = await db.query<{ t: Date }>("select public.occurrence_deadline($1::date) as t", [d]);
    expect(r.rows[0]!.t.toISOString()).toBe(occurrenceDeadline(d).toISOString());
  }
});

test("延期の再通知時刻が DB と同じ（10m・30m・1h・明日の同じ時刻・今日の指定時刻）", async () => {
  const u = await createUser(db);
  const now = "2026-11-09T22:02:30Z"; // 火 7:02:30 JST
  for (const opt of POSTPONE_OPTIONS) {
    const r = await db.query<{ id: string }>(
      "select public._create_routine($1, $2::timestamptz, $3, null, '{1,2,3,4,5,6,7}', '07:00', 15, 10) as id",
      [u, jst("2026-11-10 06:00"), `延期 ${opt}`],
    );
    const o = await db.query<{ id: string; planned_date: string; planned_start_at: Date }>(
      "select id, planned_date::text, planned_start_at from public.occurrences where routine_id = $1 and planned_date = '2026-11-10'",
      [r.rows[0]!.id],
    );
    const occ = o.rows[0]!;
    const todayAt = opt === "today_at" ? jst("2026-11-10 21:15") : null;
    const dbRes = await db.query<{ t: Date }>(
      "select public._postpone($1, $2::timestamptz, $3, $4, $5::timestamptz, null, null) as t",
      [u, now, occ.id, opt, todayAt],
    );
    const ts = remindAtFor(opt, new Date(now), { planned_date: occ.planned_date, planned_start_at: occ.planned_start_at }, "21:15");
    expect([opt, dbRes.rows[0]!.t.toISOString()]).toEqual([opt, ts!.toISOString()]);
  }
});
