// 本番用スモークテスト（supabase/tests/phase1_smoke.sql）を手元の PGlite で実行し、
// 「SMOKE_OK で終わる」ことと「実行後に1行も残らない（必ず取り消される）」ことを確かめる。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTestDb, errorOf } from "./harness";

// Phase 1 のスモークは「通知ジョブを作らない」ことも確かめるため、Phase 1 までのマイグレーションで実行する
test("Phase 1 のスモークテストは SMOKE_OK の例外で終わり、データを残さない", async () => {
  const db = await createTestDb({ upTo: "20261107999999" });
  const sql = readFileSync(join(process.cwd(), "supabase", "tests", "phase1_smoke.sql"), "utf8");
  const count = async () =>
    (
      await db.query<{ n: number }>(
        `select ((select count(*) from auth.users) + (select count(*) from public.routines)
               + (select count(*) from public.routine_versions) + (select count(*) from public.occurrences)
               + (select count(*) from public.executions) + (select count(*) from public.occurrence_events)
               + (select count(*) from public.profiles) + (select count(*) from public.notification_jobs))::int as n`,
      )
    ).rows[0]!.n;
  expect(await count()).toBe(0);
  const msg = await errorOf(db.exec(sql));
  expect(msg).toMatch(/^SMOKE_OK checks=13 \(rolled back\)$/);
  expect(await count()).toBe(0);
  // 2回目も同じ結果（前回の痕跡に依存しない）
  expect(await errorOf(db.exec(sql))).toMatch(/^SMOKE_OK/);
});

test("Phase 2 のスモークテストは SMOKE_OK の例外で終わり、データを残さない（既存ユーザーのジョブも変えない）", async () => {
  const db = await createTestDb();
  // 既存ユーザーと、その予定・通知ジョブ（本番に実データがある状態を想定）
  await db.query("insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000e1', 'real@example.test')");
  await db.query(
    "select public._create_routine('00000000-0000-4000-8000-0000000000e1', now(), '本物', null, '{1,2,3,4,5,6,7}', '23:55', 15, 10)",
  );
  const snapshot = async () =>
    (
      await db.query<{ v: string }>(
        `select concat_ws('|', (select count(*) from auth.users), (select count(*) from public.routines),
           (select count(*) from public.occurrences), (select count(*) from public.occurrence_events),
           (select count(*) from public.profiles),
           (select md5(coalesce(string_agg(j::text, ',' order by j.id), '')) from public.notification_jobs j)) as v`,
      )
    ).rows[0]!.v;
  const before = await snapshot();
  const sql = readFileSync(join(process.cwd(), "supabase", "tests", "phase2_smoke.sql"), "utf8");
  const msg = await errorOf(db.exec(sql));
  expect(msg).toMatch(/^SMOKE_OK checks=13 \(rolled back\)$/);
  expect(await snapshot()).toBe(before);
  expect(await errorOf(db.exec(sql))).toMatch(/^SMOKE_OK/);
});
