// 権限と RLS（P-06、要件 NF-03・完成条件1）。PostgREST と同じく、ロールと JWT の sub を設定して確かめる。
// Phase 0 で後回しにした「他人の端末（push_subscriptions）を読み書きできない」もここで確認する。

import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, createUser, errorOf } from "./harness";

let db: PGlite;
let alice: string;
let bob: string;
let aliceRoutine: string;
let aliceOcc: string;

const PHASE1_TABLES = ["routines", "routine_versions", "occurrences", "executions", "occurrence_events"];
const CLIENT_RPCS = [
  "ensure_occurrences", "create_routine", "edit_routine", "archive_routine",
  "record_done", "postpone", "skip_occurrence",
];

beforeAll(async () => {
  db = await createTestDb();
  alice = await createUser(db, "alice");
  bob = await createUser(db, "bob");
  // 画面と同じ入口（auth.uid() と now()）で作る。開始時刻 23:55 なら、ほぼ必ず今日か明日の予定ができる
  aliceRoutine = await as(db, "authenticated", alice, async (tx) => {
    const r = await tx.query<{ id: string }>(
      "select public.create_routine('朝のストレッチ', 'メモ', '{1,2,3,4,5,6,7}', '23:55', 15, 10) as id",
    );
    return r.rows[0]!.id;
  });
  const o = await db.query<{ id: string }>(
    "select id from public.occurrences where routine_id = $1 order by planned_date desc limit 1",
    [aliceRoutine],
  );
  aliceOcc = o.rows[0]!.id;
  await as(db, "authenticated", alice, (tx) =>
    tx.query("select public.postpone($1, '10m', null, 'tired', null)", [aliceOcc]),
  );
});

describe("表の設定", () => {
  test("public のすべての表で RLS が有効", async () => {
    const r = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(r.rows).toEqual([]);
  });

  test("anon は Phase 1 の表に何の権限も持たない。authenticated は SELECT だけ", async () => {
    const r = await db.query<{ grantee: string; table_name: string; privilege_type: string }>(
      `select grantee, table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and grantee in ('anon', 'authenticated')
          and table_name = any($1::text[]) order by 1, 2, 3`,
      [[...PHASE1_TABLES, "occurrence_facts"]],
    );
    expect(r.rows.filter((x) => x.grantee === "anon")).toEqual([]);
    expect(new Set(r.rows.map((x) => x.privilege_type))).toEqual(new Set(["SELECT"]));
  });

  test("画面から呼べるのは入口の関数だけ。内部の関数・cron 用・送信用は呼べない", async () => {
    const r = await db.query<{ proname: string; anon: boolean; authed: boolean }>(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authed
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f'`,
    );
    for (const f of r.rows) {
      expect([f.proname, f.anon]).toEqual([f.proname, false]);
      expect([f.proname, f.authed]).toEqual([f.proname, CLIENT_RPCS.includes(f.proname)]);
    }
  });

  test("security definer の関数はすべて search_path を固定している", async () => {
    const r = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
          and not coalesce(p.proconfig @> array['search_path=""'], false)`,
    );
    expect(r.rows).toEqual([]);
  });
});

describe("本人のデータだけ（RLS）", () => {
  test("本人は自分の行を読める", async () => {
    const counts = await as(db, "authenticated", alice, async (tx) => {
      const out: Record<string, number> = {};
      for (const t of [...PHASE1_TABLES, "occurrence_facts"]) {
        out[t] = Number((await tx.query<{ n: number }>(`select count(*)::int as n from public.${t}`)).rows[0]!.n);
      }
      return out;
    });
    expect(counts.routines).toBe(1);
    expect(counts.routine_versions).toBe(1);
    expect(counts.occurrences).toBeGreaterThanOrEqual(1);
    expect(counts.occurrence_events).toBeGreaterThanOrEqual(1);
    expect(counts.occurrence_facts).toBe(counts.occurrences);
  });

  test("他人（bob）には alice の行が1件も見えない", async () => {
    const counts = await as(db, "authenticated", bob, async (tx) => {
      const out: number[] = [];
      for (const t of [...PHASE1_TABLES, "occurrence_facts"]) {
        out.push(Number((await tx.query<{ n: number }>(`select count(*)::int as n from public.${t}`)).rows[0]!.n));
      }
      return out;
    });
    expect(counts).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("ログインしていない（anon）は表を読めない", async () => {
    expect(await errorOf(as(db, "anon", null, (tx) => tx.query("select * from public.routines")))).toMatch(/permission denied/);
    expect(await errorOf(as(db, "anon", null, (tx) => tx.query("select * from public.occurrence_facts")))).toMatch(/permission denied/);
  });

  test("bob は alice の予定を記録・延期・見送りできず、ルーティンも編集・アーカイブできない", async () => {
    const calls = [
      ["select public.record_done($1, now(), 15, 'now')", [aliceOcc]],
      ["select public.postpone($1, '10m', null, null, null)", [aliceOcc]],
      ["select public.skip_occurrence($1, 'other', null)", [aliceOcc]],
      ["select public.edit_routine($1, 'x', null, '{1}', '07:00', 15, 10, current_date + 1, null)", [aliceRoutine]],
      ["select public.archive_routine($1)", [aliceRoutine]],
    ] as const;
    for (const [sql, params] of calls) {
      expect(await errorOf(as(db, "authenticated", bob, (tx) => tx.query(sql, [...params])))).toMatch(/not_found/);
    }
    const st = await db.query<{ status: string; archived_at: string | null }>(
      "select o.status, r.archived_at from public.occurrences o join public.routines r on r.id = o.routine_id where o.id = $1",
      [aliceOcc],
    );
    expect(st.rows[0]).toEqual({ status: "postponed", archived_at: null });
  });

  test("表への直接の書き込みはできない（本人の行でも）", async () => {
    const tries = [
      ["insert into public.routines (user_id, name) values ($1, 'x')", [alice]],
      ["update public.occurrences set status = 'done' where routine_id = $1", [aliceRoutine]],
      ["delete from public.occurrence_events where user_id = $1", [alice]],
      ["update public.routine_versions set duration_min = 99 where routine_id = $1", [aliceRoutine]],
      ["insert into public.executions (user_id, occurrence_id, planned_date, actual_start_at, actual_end_at, actual_duration_min, executed_date, start_source) values ($1, $2, current_date, now(), now(), 1, current_date, 'now')", [alice, aliceOcc]],
    ] as const;
    for (const [sql, params] of tries) {
      expect(await errorOf(as(db, "authenticated", alice, (tx) => tx.query(sql, [...params])))).toMatch(/permission denied/);
    }
  });

  test("ログインしていないと入口の関数も使えない", async () => {
    expect(
      await errorOf(as(db, "anon", null, (tx) => tx.query("select public.create_routine('x', null, '{1}', '07:00', 15, 10)"))),
    ).toMatch(/permission denied/);
    expect(
      await errorOf(as(db, "authenticated", null, (tx) => tx.query("select public.ensure_occurrences()"))),
    ).toMatch(/not_authenticated/);
  });
});

describe("Phase 0 の後回し：他人の端末に届かない（push_subscriptions）", () => {
  const sub = (endpoint: string) => ({
    endpoint,
    p256dh: "B".repeat(87),
    auth: "A".repeat(22),
  });

  test("bob は alice の端末を見られない・alice として登録できない・書き換えられない", async () => {
    const a = sub("https://web.push.apple.com/alice-device");
    await as(db, "authenticated", alice, (tx) =>
      tx.query("insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)", [alice, a.endpoint, a.p256dh, a.auth]),
    );
    const seen = await as(db, "authenticated", bob, (tx) => tx.query("select * from public.push_subscriptions"));
    expect(seen.rows).toEqual([]);
    const b = sub("https://web.push.apple.com/bob-pretending");
    expect(
      await errorOf(
        as(db, "authenticated", bob, (tx) =>
          tx.query("insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)", [alice, b.endpoint, b.p256dh, b.auth]),
        ),
      ),
    ).toMatch(/row-level security/);
    const upd = await as(db, "authenticated", bob, (tx) =>
      tx.query("update public.push_subscriptions set user_id = $1 where endpoint = $2", [bob, a.endpoint]),
    );
    expect(upd.affectedRows ?? 0).toBe(0);
    const owner = await db.query<{ user_id: string }>("select user_id from public.push_subscriptions where endpoint = $1", [a.endpoint]);
    expect(owner.rows[0]!.user_id).toBe(alice);
  });

  test("通知ジョブは他人の予定に結べない（予定と持ち主が一致しないとき外部キーで拒否）", async () => {
    expect(
      await errorOf(
        db.query(
          "insert into public.notification_jobs (user_id, occurrence_id, kind, fire_at, expires_at) values ($1, $2, 'initial', now(), now() + interval '1 hour')",
          [bob, aliceOcc],
        ),
      ),
    ).toMatch(/foreign key/);
  });
});

describe("cron と Phase 0 の送信経路", () => {
  test("cron は 0:00 JST の予定作成・0:05 JST の未実施確定・毎分の送信の3つ", async () => {
    const r = await db.query<{ jobname: string; schedule: string; command: string }>(
      "select jobname, schedule, command from cron.job order by jobname",
    );
    expect(r.rows).toEqual([
      { jobname: "routine-lab-close-missed", schedule: "5 15 * * *", command: "select public.close_missed()" },
      { jobname: "routine-lab-dispatch-push", schedule: "* * * * *", command: "select public.dispatch_due_push()" },
      { jobname: "routine-lab-ensure-occurrences", schedule: "0 15 * * *", command: "select public.ensure_occurrences_all()" },
    ]);
  });

  test("cron 用の関数は外部と通信しない（Phase 1 では通知ジョブを作らない）", async () => {
    await db.query("select public.ensure_occurrences_all()");
    await db.query("select public.close_missed()");
    await db.query("select public.dispatch_due_push()");
    const calls = await db.query<{ n: number }>("select count(*)::int as n from net.calls");
    expect(calls.rows[0]!.n).toBe(0);
    const jobs = await db.query<{ n: number }>("select count(*)::int as n from public.notification_jobs where kind <> 'test'");
    expect(jobs.rows[0]!.n).toBe(0);
  });

  test("アカウントを消すと、本人のデータは連鎖して消える（履歴の保護は連鎖削除を止めない）", async () => {
    const carol = await createUser(db, "carol");
    await as(db, "authenticated", carol, (tx) =>
      tx.query("select public.create_routine('夜の読書', null, '{1,2,3,4,5,6,7}', '23:55', 30, 10)"),
    );
    await db.query("delete from auth.users where id = $1", [carol]);
    const left = await db.query<{ n: number }>(
      `select (select count(*) from public.routines where user_id = $1)
            + (select count(*) from public.routine_versions where user_id = $1)
            + (select count(*) from public.occurrences where user_id = $1) as n`,
      [carol],
    );
    expect(Number(left.rows[0]!.n)).toBe(0);
  });
});
