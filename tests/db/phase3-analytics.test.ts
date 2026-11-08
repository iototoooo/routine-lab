// Phase 3 の DB（docs/phase3-plan.md 2章）：「分析に含めない」の印と、延期・見送り・未実施のイベントのビュー。
// 印は分析の対象を決めるだけで、予定・実績・版・イベント・通知ジョブを変えないことを確かめる。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, createUser, errorOf, jst, prepareMigration } from "./harness";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});

const MON = "2026-11-09";
const TUE = "2026-11-10";

async function createRoutine(u: string, now: string, start = "07:00", name = "朝のストレッチ"): Promise<string> {
  const r = await db.query<{ id: string }>(
    "select public._create_routine($1, $2::timestamptz, $3, null, '{1,2,3,4,5,6,7}', $4, 15, 10) as id",
    [u, now, name, start],
  );
  return r.rows[0]!.id;
}
async function occOn(rid: string, date: string): Promise<string> {
  const r = await db.query<{ id: string }>("select id from public.occurrences where routine_id = $1 and planned_date = $2", [rid, date]);
  return r.rows[0]!.id;
}
/** そのルーティンの予定・版・実績・イベント・通知ジョブ（印以外のすべて）の指紋 */
async function recordsOf(rid: string): Promise<string> {
  const r = await db.query<{ v: string }>(
    `select md5(concat_ws('|',
       (select string_agg(o::text, ',' order by o.id) from public.occurrences o where o.routine_id = $1),
       (select string_agg(v::text, ',' order by v.id) from public.routine_versions v where v.routine_id = $1),
       (select string_agg(e::text, ',' order by e.id) from public.executions e join public.occurrences o on o.id = e.occurrence_id where o.routine_id = $1),
       (select string_agg(x::text, ',' order by x.id) from public.occurrence_events x join public.occurrences o on o.id = x.occurrence_id where o.routine_id = $1),
       (select string_agg(j::text, ',' order by j.id) from public.notification_jobs j join public.occurrences o on o.id = j.occurrence_id where o.routine_id = $1))) as v`,
    [rid],
  );
  return r.rows[0]!.v;
}
const flagOf = async (rid: string) =>
  (await db.query<{ f: boolean }>("select exclude_from_analytics as f from public.routines where id = $1", [rid])).rows[0]!.f;

describe("「分析に含めない」の印（routines.exclude_from_analytics）", () => {
  test("反映前からあるルーティンも、新しいルーティンも、既定は「含める」（false）", async () => {
    const old = await createTestDb({ upTo: "20261108999999" });
    await old.query("insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000f1', 'old@example.test')");
    await old.query(
      "select public._create_routine('00000000-0000-4000-8000-0000000000f1', now(), '既存', null, '{1}', '07:00', 15, 10)",
    );
    await old.exec(prepareMigration(readFileSync(join(process.cwd(), "supabase", "migrations", "20261109000000_phase3_analytics.sql"), "utf8")));
    const r = await old.query<{ f: boolean }>("select exclude_from_analytics as f from public.routines");
    expect(r.rows).toEqual([{ f: false }]);

    const u = await createUser(db);
    expect(await flagOf(await createRoutine(u, jst(`${TUE} 05:00`)))).toBe(false);
  });

  test("本人は切り替えられ、予定・版・実績・イベント・通知ジョブは1つも変わらない", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${MON} 05:00`));
    const occ = await occOn(rid, MON);
    await db.query("select public._record_done($1, $2::timestamptz, $3, $4::timestamptz, 20, 'now')", [u, jst(`${MON} 07:40`), occ, jst(`${MON} 07:10`)]);
    await db.query("select public._postpone($1, $2::timestamptz, $3, '30m', null, 'no_time', null)", [u, jst(`${TUE} 07:05`), await occOn(rid, TUE)]);
    const before = await recordsOf(rid);
    const pendingBefore = await db.query<{ n: number }>("select count(*)::int as n from public.notification_jobs where user_id = $1 and status = 'pending'", [u]);

    const set = await as(db, "authenticated", u, (tx) => tx.query<{ r: boolean }>("select public.set_routine_analytics($1, true) as r", [rid]));
    expect(set.rows[0]!.r).toBe(true);
    expect(await flagOf(rid)).toBe(true);
    expect(await recordsOf(rid)).toBe(before);
    const pendingAfter = await db.query<{ n: number }>("select count(*)::int as n from public.notification_jobs where user_id = $1 and status = 'pending'", [u]);
    expect(pendingAfter.rows[0]!.n).toBe(pendingBefore.rows[0]!.n);

    await as(db, "authenticated", u, (tx) => tx.query("select public.set_routine_analytics($1, false)", [rid]));
    expect(await flagOf(rid)).toBe(false);
    expect(await recordsOf(rid)).toBe(before);
  });

  test("アーカイブ済みのルーティンでも切り替えられる（過去の記録を外す・戻すため）", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${MON} 05:00`));
    await db.query("select public._archive_routine($1, $2::timestamptz, $3)", [u, jst(`${MON} 06:00`), rid]);
    await as(db, "authenticated", u, (tx) => tx.query("select public.set_routine_analytics($1, true)", [rid]));
    expect(await flagOf(rid)).toBe(true);
  });

  test("他人のルーティンは変えられず（not_found）、未ログイン・値なしも拒否する", async () => {
    const alice = await createUser(db, "alice");
    const bob = await createUser(db, "bob");
    const rid = await createRoutine(alice, jst(`${MON} 05:00`));
    expect(await errorOf(as(db, "authenticated", bob, (tx) => tx.query("select public.set_routine_analytics($1, true)", [rid])))).toMatch(/not_found/);
    expect(await errorOf(as(db, "anon", null, (tx) => tx.query("select public.set_routine_analytics($1, true)", [rid])))).toMatch(/permission denied/);
    expect(await errorOf(db.query("select public._set_routine_analytics(null, now(), $1, true)", [rid]))).toMatch(/not_authenticated/);
    expect(await errorOf(as(db, "authenticated", alice, (tx) => tx.query("select public.set_routine_analytics($1, null)", [rid])))).toMatch(/invalid_argument/);
    expect(await errorOf(as(db, "authenticated", alice, (tx) => tx.query("update public.routines set exclude_from_analytics = true where id = $1", [rid])))).toMatch(/permission denied/);
    expect(await flagOf(rid)).toBe(false);
  });
});

describe("延期・見送り・未実施のイベントのビュー（occurrence_reason_facts）", () => {
  test("延期・見送り・未実施だけを、予定日・ルーティン・版と理由・延期の選択肢つきで返す", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${MON} 05:00`));
    const mon = await occOn(rid, MON);
    const tue = await occOn(rid, TUE);
    // 月：延期 2 回 → 完了。火：延期 → 見送り
    await db.query("select public._postpone($1, $2::timestamptz, $3, '10m', null, 'tired', null)", [u, jst(`${MON} 07:01`), mon]);
    await db.query("select public._postpone($1, $2::timestamptz, $3, '1h', null, null, null)", [u, jst(`${MON} 07:12`), mon]);
    await db.query("select public._record_done($1, $2::timestamptz, $3, $4::timestamptz, 15, 'now')", [u, jst(`${MON} 08:30`), mon, jst(`${MON} 08:15`)]);
    await db.query("select public._postpone($1, $2::timestamptz, $3, 'today_at', $4::timestamptz, 'no_time', null)", [u, jst(`${TUE} 07:02`), tue, jst(`${TUE} 20:00`)]);
    await db.query("select public._skip($1, $2::timestamptz, $3, 'plans', null)", [u, jst(`${TUE} 20:05`), tue]);

    const rows = await as(db, "authenticated", u, (tx) =>
      tx.query<{ planned_date: string; type: string; reason_code: string | null; postpone_option: string | null; routine_id: string; version_ok: boolean }>(
        `select f.planned_date::text, f.type, f.reason_code, f.postpone_option, f.routine_id,
                f.routine_version_id = o.routine_version_id as version_ok
           from public.occurrence_reason_facts f join public.occurrences o on o.id = f.occurrence_id
          where f.routine_id = $1 order by f.event_id`,
        [rid],
      ),
    );
    expect(rows.rows).toEqual([
      { planned_date: MON, type: "postponed", reason_code: "tired", postpone_option: "10m", routine_id: rid, version_ok: true },
      { planned_date: MON, type: "postponed", reason_code: null, postpone_option: "1h", routine_id: rid, version_ok: true },
      { planned_date: TUE, type: "postponed", reason_code: "no_time", postpone_option: "today_at", routine_id: rid, version_ok: true },
      { planned_date: TUE, type: "skipped", reason_code: "plans", postpone_option: null, routine_id: rid, version_ok: true },
    ]);
  });

  test("期限を過ぎた予定の未実施（システムが確定）も入る", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${MON} 05:00`), "21:00", "夜");
    await db.query("select public._close_missed($1, '2026-11-11T15:00:00Z')", [u]); // 11/12 0:00 JST：11/10 までが確定
    const r = await db.query<{ planned_date: string; type: string; actor: string }>(
      "select planned_date::text, type, actor from public.occurrence_reason_facts where routine_id = $1 order by planned_date",
      [rid],
    );
    expect(r.rows).toEqual([
      { planned_date: MON, type: "missed", actor: "system" },
      { planned_date: TUE, type: "missed", actor: "system" },
    ]);
  });
});
