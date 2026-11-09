// supabase/rollback/20261107_phase1_down.sql の確認：Phase 1 を反映してから取り消すと、
// Phase 0 だけを反映した状態と DB の構造（表・関数・権限・RLS・cron・拡張）が同じになり、Phase 0 の行も変わらない。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { describe, expect, it } from "vitest";
import { SUPABASE_STUB, migrationFiles, prepareMigration } from "./harness";

const dir = join(process.cwd(), "supabase");
const read = (p: string) => readFileSync(join(dir, p), "utf8");
const isPhase1 = (f: string) => f.startsWith("20261107");

async function apply(db: PGlite, files: string[]) {
  for (const f of files) {
    await db.exec(prepareMigration(read(join("migrations", f))));
    await db.query("insert into supabase_migrations.schema_migrations values ($1)", [f.slice(0, 14)]);
  }
}

const FINGERPRINT = `
select 'rel' k, n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relrowsecurity::text || ':' || coalesce(c.relacl::text, '') v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'extensions')
union all select 'fn', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'extensions')
union all select 'con', conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid)
  from pg_constraint where connamespace = 'public'::regnamespace
union all select 'pol', tablename || '.' || policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') from pg_policies
union all select 'trg', tgrelid::regclass::text || '.' || tgname from pg_trigger where not tgisinternal
union all select 'ext', extname from pg_extension
union all select 'cron', jobname || ':' || schedule || ':' || command from cron.job
union all select 'mig', version from supabase_migrations.schema_migrations
order by 1, 2`;

async function fingerprint(db: PGlite) {
  return (await db.query<{ k: string; v: string }>(FINGERPRINT)).rows.map((r) => `${r.k} ${r.v}`);
}

async function phase0Rows(db: PGlite) {
  const r = await db.query<{ v: string }>(`
    select string_agg(t, '|' order by t) v from (
      select 'p:' || md5(p::text) t from public.profiles p
      union all select 's:' || md5(s::text) from public.push_subscriptions s
      union all select 'j:' || md5(j::text) from public.notification_jobs j) x`);
  return r.rows[0]!.v;
}

async function seedPhase0(db: PGlite) {
  const u = "00000000-0000-4000-8000-0000000000a1";
  await db.query("insert into auth.users (id, email) values ($1, 'rb@example.test')", [u]);
  await db.query(
    "insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://push.example.test/x', repeat('k', 87), repeat('a', 22))",
    [u],
  );
  await db.query(
    "insert into public.notification_jobs (user_id, kind, fire_at, expires_at) values ($1, 'test', now(), now() + interval '1 hour')",
    [u],
  );
}

describe("Phase 4 の取り消し SQL（判断記録・提案から作った版があれば止まる）", () => {
  const files = migrationFiles();
  const upToPhase3 = files.filter((f) => f < "20261110");
  const phase4 = files.filter((f) => f.startsWith("20261110"));
  const u = "00000000-0000-4000-8000-0000000000a1";
  const R01 = JSON.stringify({ weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:30", duration_min: 15 });
  const R03 = JSON.stringify({ weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:00", duration_min: 30 });
  const ROWS = `
    (select string_agg(r::text, ',' order by r.id) from public.routines r),
    (select string_agg(v::text, ',' order by v.id) from public.routine_versions v),
    (select string_agg(o::text, ',' order by o.id) from public.occurrences o),
    (select string_agg(e::text, ',' order by e.id) from public.executions e),
    (select string_agg(e::text, ',' order by e.id) from public.occurrence_events e),
    (select string_agg(j::text, ',' order by j.id) from public.notification_jobs j),
    (select string_agg(s::text, ',' order by s.id) from public.push_subscriptions s)`;

  /** Phase 3 まで反映 → 既存の記録（予定・延期・通知ジョブ・端末）→ Phase 4 を反映した DB */
  async function setup() {
    expect(phase4).toHaveLength(1);
    const db = await PGlite.create({ extensions: { btree_gist } });
    await db.exec(SUPABASE_STUB);
    await apply(db, upToPhase3);
    await seedPhase0(db);
    const r = await db.query<{ id: string }>(
      "select public._create_routine($1, '2026-11-10 06:00+09', 'x', null, '{1,2,3,4,5,6,7}', '07:00', 15, 10) as id",
      [u],
    );
    const rid = r.rows[0]!.id;
    const occ = await db.query<{ id: string }>("select id from public.occurrences where routine_id = $1 order by planned_date limit 1", [rid]);
    await db.query("select public._postpone($1, '2026-11-10 06:00+09', $2, '10m', null, 'tired', null)", [u, occ.rows[0]!.id]);
    await apply(db, phase4);
    const v1 = (await db.query<{ id: string }>("select id from public.routine_versions where routine_id = $1", [rid])).rows[0]!.id;
    return { db, rid, v1 };
  }
  /** 既存の表の行の指紋（判断記録の表は別に数える） */
  async function rowsOf(db: PGlite) {
    return (await db.query<{ v: string }>(`select md5(concat_ws('|', ${ROWS})) as v`)).rows[0]!.v;
  }
  /** 構造（表・関数・制約・ポリシー・トリガー・cron・マイグレーション）と、すべての行（判断記録を含む） */
  async function state(db: PGlite) {
    const s = await db.query<{ v: string }>("select coalesce(string_agg(x::text, ',' order by x.id), 'empty') as v from public.suggestions x");
    return { structure: await fingerprint(db), rows: await rowsOf(db), suggestions: s.rows[0]!.v };
  }
  /** 取り消し SQL を実行する。止まったら、失敗したトランザクションを閉じる（本番では接続を閉じるのと同じ） */
  async function runRollback(db: PGlite): Promise<string | null> {
    try {
      await db.exec(read("rollback/20261110_phase4_down.sql"));
      return null;
    } catch (e) {
      await db.exec("rollback");
      return e instanceof Error ? e.message : String(e);
    }
  }

  it("A. 提案を承認した後は止まって理由を示し、判断記録・提案から作った版・DB の構造と行は1つも変わらない", async () => {
    const { db, rid, v1 } = await setup();
    await db.query("select public._accept_suggestion($1, '2026-11-10 06:00+09', $2, 'R-01', $3, '{}'::jsonb, $4::jsonb, '2026-11-11', null)", [u, rid, v1, R01]);
    const before = await state(db);
    expect(await runRollback(db)).toBe(
      "PHASE4_ROLLBACK_REFUSED: 改善提案の判断記録 1 件・提案から作った版 1 件があるため、取り消しを中止しました（何も変更していません）",
    );
    expect(await state(db)).toEqual(before);
    const vs = await db.query<{ source: string }>("select source from public.routine_versions where routine_id = $1 order by version_no", [rid]);
    expect(vs.rows.map((x) => x.source)).toEqual(["manual", "suggestion"]);
    expect((await db.query<{ status: string }>("select status from public.suggestions")).rows).toEqual([{ status: "accepted" }]);
  });

  it("B. 提案を却下した後も止まり、却下記録・DB の構造と行は変わらない", async () => {
    const { db, rid, v1 } = await setup();
    await db.query("select public._reject_suggestion($1, '2026-11-10 06:00+09', $2, 'R-03', $3, '{}'::jsonb, $4::jsonb)", [u, rid, v1, R03]);
    const before = await state(db);
    expect(await runRollback(db)).toMatch(/^PHASE4_ROLLBACK_REFUSED: 改善提案の判断記録 1 件・提案から作った版 0 件があるため/);
    expect(await state(db)).toEqual(before);
    expect((await db.query<{ status: string }>("select status from public.suggestions")).rows).toEqual([{ status: "rejected" }]);
  });

  it("C. 判断記録・提案から作った版が 0 件なら Phase 3 の構造に完全に戻り、既存の行は変わらず、Phase 4 を再適用できる", async () => {
    const base = await PGlite.create({ extensions: { btree_gist } });
    await base.exec(SUPABASE_STUB);
    await apply(base, upToPhase3);
    const expected = await fingerprint(base);

    const { db, rid } = await setup();
    // 手動の編集（Phase 4 では _apply_routine_version を経由）をしてあっても、提案由来ではないので戻せる
    await db.query("select public._edit_routine($1, '2026-11-10 06:30+09', $2, 'x', null, '{1,2,3}', '08:00', 15, 10, '2026-11-12', null)", [u, rid]);
    const before = await rowsOf(db);
    expect((await fingerprint(db)).length).toBeGreaterThan(expected.length);

    expect(await runRollback(db)).toBeNull();
    expect(await fingerprint(db)).toEqual(expected);
    expect(await rowsOf(db)).toBe(before);
    // Phase 3 の定義の手動編集が今までどおり動く
    await db.query("select public._edit_routine($1, '2026-11-10 06:40+09', $2, 'x', null, '{1,2}', '08:00', 15, 10, '2026-11-13', null)", [u, rid]);

    // 再適用でき、承認も動く
    await apply(db, phase4);
    const cur = (await db.query<{ id: string }>("select id from public.routine_versions where routine_id = $1 and valid_to is null", [rid])).rows[0]!.id;
    await db.query("select public._accept_suggestion($1, '2026-11-10 07:00+09', $2, 'R-03', $3, '{}'::jsonb, $4::jsonb, '2026-11-14', null)", [
      u, rid, cur, JSON.stringify({ weekdays: [1, 2], start_time: "08:00", duration_min: 30 }),
    ]);
    expect((await db.query("select 1 from public.routine_versions where source = 'suggestion'")).rows).toHaveLength(1);
  });

  it("D. 判断記録が 0 件でも提案から作った版がある異常な状態なら止まり、履歴は変わらない", async () => {
    const { db, rid, v1 } = await setup();
    await db.query("select public._accept_suggestion($1, '2026-11-10 06:00+09', $2, 'R-01', $3, '{}'::jsonb, $4::jsonb, '2026-11-11', null)", [u, rid, v1, R01]);
    // 異常な状態を作る：トリガー（変更禁止・外部キー）を止めて判断記録だけを消す（ふだんは消せない）
    await db.exec("set session_replication_role = replica; delete from public.suggestions; set session_replication_role = default;");
    const before = await state(db);
    expect(before.suggestions).toBe("empty");
    expect(await runRollback(db)).toMatch(/^PHASE4_ROLLBACK_REFUSED: 改善提案の判断記録 0 件・提案から作った版 1 件があるため/);
    expect(await state(db)).toEqual(before);
  });
});

describe("Phase 3 の取り消し SQL", () => {
  it("反映 → 印の切り替え → 取り消しで Phase 2 だけの状態に戻り、予定・実績・イベント・通知ジョブは変わらない", async () => {
    const files = migrationFiles();
    const upToPhase2 = files.filter((f) => f < "20261109");
    const phase3 = files.filter((f) => f.startsWith("20261109"));
    expect(phase3).toHaveLength(1);

    const base = await PGlite.create({ extensions: { btree_gist } });
    await base.exec(SUPABASE_STUB);
    await apply(base, upToPhase2);
    const expected = await fingerprint(base);

    const db = await PGlite.create({ extensions: { btree_gist } });
    await db.exec(SUPABASE_STUB);
    await apply(db, upToPhase2);
    await seedPhase0(db);
    const u = "00000000-0000-4000-8000-0000000000a1";
    const r = await db.query<{ id: string }>(
      "select public._create_routine($1, '2026-11-10 06:00+09', 'x', null, '{1,2,3,4,5,6,7}', '07:00', 15, 10) as id",
      [u],
    );
    const occ = await db.query<{ id: string }>("select id from public.occurrences where routine_id = $1 order by planned_date limit 1", [r.rows[0]!.id]);
    await db.query("select public._postpone($1, '2026-11-10 06:00+09', $2, '10m', null, 'tired', null)", [u, occ.rows[0]!.id]);
    const rows = async () =>
      (
        await db.query<{ v: string }>(
          `select md5(concat_ws('|',
             (select string_agg(o::text, ',' order by o.id) from public.occurrences o),
             (select string_agg(v::text, ',' order by v.id) from public.routine_versions v),
             (select string_agg(e::text, ',' order by e.id) from public.occurrence_events e),
             (select string_agg(j::text, ',' order by j.id) from public.notification_jobs j))) as v`,
        )
      ).rows[0]!.v;
    const before = await rows();

    await apply(db, phase3);
    await db.query("select public._set_routine_analytics($1, now(), $2, true)", [u, r.rows[0]!.id]);
    expect((await fingerprint(db)).length).toBeGreaterThan(expected.length);
    await db.exec(read("rollback/20261109_phase3_down.sql"));

    expect(await fingerprint(db)).toEqual(expected);
    expect(await rows()).toBe(before);
  });
});

describe("Phase 2 の取り消し SQL", () => {
  it("反映 → 予定・通知の操作 → 取り消しで Phase 1 だけの状態に戻り、Phase 0・1 の行は消えない", async () => {
    const files = migrationFiles();
    const upToPhase1 = files.filter((f) => f < "20261108");
    const phase2 = files.filter((f) => f.startsWith("20261108"));
    expect(phase2).toHaveLength(3);

    const base = await PGlite.create({ extensions: { btree_gist } });
    await base.exec(SUPABASE_STUB);
    await apply(base, upToPhase1);
    const expected = await fingerprint(base);

    const db = await PGlite.create({ extensions: { btree_gist } });
    await db.exec(SUPABASE_STUB);
    await apply(db, upToPhase1);
    await seedPhase0(db);
    await apply(db, phase2);
    // Phase 2 の状態で予定を作り（通知ジョブができる）、延期もしておく
    const u = "00000000-0000-4000-8000-0000000000a1";
    const r = await db.query<{ id: string }>(
      "select public._create_routine($1, '2026-11-10 06:00+09', 'x', null, '{1,2,3,4,5,6,7}', '07:00', 15, 10) as id",
      [u],
    );
    const occ = await db.query<{ id: string }>("select id from public.occurrences where routine_id = $1 order by planned_date limit 1", [r.rows[0]!.id]);
    await db.query("select public._postpone($1, '2026-11-10 06:00+09', $2, '10m', null, null, null)", [u, occ.rows[0]!.id]);
    const before = await db.query<{ n: number }>(
      "select ((select count(*) from public.routines) + (select count(*) from public.occurrences) + (select count(*) from public.occurrence_events) + (select count(*) from public.notification_jobs))::int as n",
    );
    expect((await fingerprint(db)).length).toBeGreaterThan(expected.length);

    await db.exec(read("rollback/20261108_phase2_down.sql"));

    expect(await fingerprint(db)).toEqual(expected);
    const after = await db.query<{ n: number }>(
      "select ((select count(*) from public.routines) + (select count(*) from public.occurrences) + (select count(*) from public.occurrence_events) + (select count(*) from public.notification_jobs))::int as n",
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    const open = await db.query<{ n: number }>(
      "select count(*)::int as n from public.notification_jobs where kind <> 'test' and status in ('pending', 'sending')",
    );
    expect(open.rows[0]!.n).toBe(0);
  });
});

describe("Phase 1 の取り消し SQL", () => {
  it("反映 → 取り消しで Phase 0 だけの状態に戻り、Phase 0 の行は変わらない", async () => {
    const files = migrationFiles();
    const phase0 = files.filter((f) => f < "20261107");
    const phase1 = files.filter(isPhase1);
    // （Phase 2 以降のファイルはこのテストの対象外）
    expect(phase1).toHaveLength(4);

    const base = await PGlite.create({ extensions: { btree_gist } });
    await base.exec(SUPABASE_STUB);
    await apply(base, phase0);
    await seedPhase0(base);
    const expected = await fingerprint(base);

    const db = await PGlite.create({ extensions: { btree_gist } });
    await db.exec(SUPABASE_STUB);
    await apply(db, phase0);
    await seedPhase0(db);
    const rowsBefore = await phase0Rows(db);
    await apply(db, phase1);
    expect((await fingerprint(db)).length).toBeGreaterThan(expected.length);
    await db.exec(read("rollback/20261107_phase1_down.sql"));

    expect(await fingerprint(db)).toEqual(expected);
    expect(await phase0Rows(db)).toBe(rowsBefore);
  });
});
