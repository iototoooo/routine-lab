// 本番用スモークテスト（supabase/tests/phase1_smoke.sql）を手元の PGlite で実行し、
// 「SMOKE_OK で終わる」ことと「実行後に1行も残らない（必ず取り消される）」ことを確かめる。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTestDb, errorOf } from "./harness";

test("スモークテストは SMOKE_OK の例外で終わり、データを残さない", async () => {
  const db = await createTestDb();
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
