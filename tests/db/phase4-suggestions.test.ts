// Phase 4 の DB（docs/phase4-plan.md 3章）：改善提案の承認・却下の記録と、承認したときだけ版を作ること。
// 古い提案・二重の承認・28 日以内の再判断・他人・テスト用・アーカイブを拒否し、記録は変更・削除できないことを確かめる。
import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, createUser, errorOf, jst } from "./harness";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});

const MON = "2026-11-09";
const NOW = jst(`${MON} 21:00`);

async function createRoutine(u: string, opts: { start?: string; weekdays?: string; duration?: number } = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    "select public._create_routine($1, $2::timestamptz, 'ストレッチ', 'メモ', $3, $4, $5, 10) as id",
    [u, jst(`${MON} 05:00`), opts.weekdays ?? "{1,2,3,4,5,6,7}", opts.start ?? "07:00", opts.duration ?? 15],
  );
  return r.rows[0]!.id;
}
async function currentVersion(rid: string) {
  const r = await db.query<{ id: string; version_no: number; start_time: string; weekdays: number[]; duration_min: number; snooze_min: number; name: string; note: string | null; source: string; suggestion_id: string | null; change_reason: string | null; valid_from: string }>(
    "select id, version_no, start_time::text, weekdays, duration_min, snooze_min, name, note, source, suggestion_id, change_reason, valid_from::text from public.routine_versions where routine_id = $1 and valid_to is null",
    [rid],
  );
  return r.rows[0]!;
}
const versionCount = async (rid: string) =>
  (await db.query<{ n: number }>("select count(*)::int as n from public.routine_versions where routine_id = $1", [rid])).rows[0]!.n;

const EVIDENCE = JSON.stringify({ from: "2026-10-12", to: "2026-11-08", n: 6, medianDelay: 25 });
const R01 = JSON.stringify({ weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:30", duration_min: 15 });

type AcceptArgs = { rule?: string; base?: string; proposed?: string; validFrom?: string; reason?: string | null; now?: string; evidence?: string };
function accept(u: string, rid: string, a: AcceptArgs & { base: string }) {
  return db.query<{ id: string }>(
    "select public._accept_suggestion($1, $2::timestamptz, $3, $4, $5, $6::jsonb, $7::jsonb, $8::date, $9) as id",
    [u, a.now ?? NOW, rid, a.rule ?? "R-01", a.base, a.evidence ?? EVIDENCE, a.proposed ?? R01, a.validFrom ?? "2026-11-10", a.reason === undefined ? "提案 R-01" : a.reason],
  );
}
function reject(u: string, rid: string, a: { rule?: string; base: string; proposed?: string; now?: string }) {
  return db.query<{ id: string }>(
    "select public._reject_suggestion($1, $2::timestamptz, $3, $4, $5, $6::jsonb, $7::jsonb) as id",
    [u, a.now ?? NOW, rid, a.rule ?? "R-01", a.base, EVIDENCE, a.proposed ?? R01],
  );
}
/** そのルーティンの予定・版・実績・イベント・通知ジョブの指紋 */
async function recordsOf(rid: string): Promise<string> {
  const r = await db.query<{ v: string }>(
    `select md5(concat_ws('|',
       (select string_agg(o::text, ',' order by o.id) from public.occurrences o where o.routine_id = $1),
       (select string_agg(v::text, ',' order by v.id) from public.routine_versions v where v.routine_id = $1),
       (select string_agg(x::text, ',' order by x.id) from public.occurrence_events x join public.occurrences o on o.id = x.occurrence_id where o.routine_id = $1),
       (select string_agg(j::text, ',' order by j.id) from public.notification_jobs j join public.occurrences o on o.id = j.occurrence_id where o.routine_id = $1))) as v`,
    [rid],
  );
  return r.rows[0]!.v;
}

describe("承認（accept_suggestion）", () => {
  test("承認すると版が1つ増え、きっかけ＝提案・提案の記録とつながり、名前・メモ・再通知は今のまま", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u);
    const base = await currentVersion(rid);
    const r = await accept(u, rid, { base: base.id });
    const vid = r.rows[0]!.id;

    const cur = await currentVersion(rid);
    expect(cur.id).toBe(vid);
    expect(cur).toMatchObject({ version_no: 2, start_time: "07:30:00", duration_min: 15, snooze_min: 10, name: "ストレッチ", note: "メモ", source: "suggestion", change_reason: "提案 R-01", valid_from: "2026-11-10" });
    const s = await db.query<{ id: string; status: string; applied_version_id: string; base_version_id: string; current_settings: unknown; proposed: unknown; evidence: unknown }>(
      "select id, status, applied_version_id, base_version_id, current_settings, proposed, evidence from public.suggestions where routine_id = $1",
      [rid],
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({
      id: cur.suggestion_id, status: "accepted", applied_version_id: vid, base_version_id: base.id,
      current_settings: { weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:00", duration_min: 15 },
      proposed: { weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:30", duration_min: 15 },
      evidence: JSON.parse(EVIDENCE),
    });
    // 前の版は閉じただけで残る
    const old = await db.query<{ valid_to: string; source: string }>("select valid_to::text, source from public.routine_versions where id = $1", [base.id]);
    expect(old.rows[0]).toEqual({ valid_to: "2026-11-10", source: "manual" });
  });

  test("適用開始日以降のまだ通知していない予定だけを新しい時刻にし、通知ジョブも付け直す（今日の通知済み・記録済みは変えない）", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u);
    // 11/9（今日）は記録済み、11/10（明日）はまだ通知前
    const occ = async (d: string) =>
      (await db.query<{ id: string }>("select id from public.occurrences where routine_id = $1 and planned_date = $2", [rid, d])).rows[0]!.id;
    await db.query("select public._record_done($1, $2::timestamptz, $3, $4::timestamptz, 15, 'now')", [u, jst(`${MON} 07:50`), await occ(MON), jst(`${MON} 07:35`)]);
    const todayBefore = await db.query("select o::text from public.occurrences o where id = $1", [await occ(MON)]);
    const base = await currentVersion(rid);
    await accept(u, rid, { base: base.id, validFrom: "2026-11-10" });

    expect((await db.query("select o::text from public.occurrences o where id = $1", [await occ(MON)])).rows).toEqual(todayBefore.rows);
    const tue = await db.query<{ planned_start_at: string; version_no: number }>(
      "select o.planned_start_at::text, v.version_no from public.occurrences o join public.routine_versions v on v.id = o.routine_version_id where o.id = $1",
      [await occ("2026-11-10")],
    );
    expect(tue.rows[0]).toEqual({ planned_start_at: "2026-11-09 22:30:00+00", version_no: 2 });
    const jobs = await db.query<{ fire_at: string; status: string }>(
      "select fire_at::text, status from public.notification_jobs where occurrence_id = $1 and kind = 'initial' order by fire_at",
      [await occ("2026-11-10")],
    );
    // 古い時刻のジョブは取り消し、新しい時刻のジョブが1つだけ送信待ち（重複しない）
    expect(jobs.rows.filter((j) => j.status === "pending")).toEqual([{ fire_at: "2026-11-09 22:30:00+00", status: "pending" }]);
    expect(jobs.rows.filter((j) => j.status === "cancelled").map((j) => j.fire_at)).toEqual(["2026-11-09 22:00:00+00"]);
    // 実績は1件のまま（上書きしない）
    const ex = await db.query<{ n: number }>("select count(*)::int as n from public.executions e join public.occurrences o on o.id = e.occurrence_id where o.routine_id = $1", [rid]);
    expect(ex.rows[0]!.n).toBe(1);
  });

  test("R-02 は曜日を1つ外し、外した曜日のまだ通知していない予定は取り消し（消さない）、R-03 は所要時間を延ばす", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, { weekdays: "{1,2,3}" });
    const base = await currentVersion(rid);
    await accept(u, rid, { rule: "R-02", base: base.id, proposed: JSON.stringify({ weekdays: [1, 3], start_time: "07:00", duration_min: 15 }) });
    const v2 = await currentVersion(rid);
    expect(v2.weekdays).toEqual([1, 3]);
    const tue = await db.query<{ status: string }>("select status from public.occurrences where routine_id = $1 and planned_date = '2026-11-10'", [rid]);
    expect(tue.rows).toEqual([{ status: "cancelled" }]);

    const rid3 = await createRoutine(u);
    const b3 = await currentVersion(rid3);
    await accept(u, rid3, { rule: "R-03", base: b3.id, proposed: JSON.stringify({ weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:00", duration_min: 25 }) });
    expect((await currentVersion(rid3)).duration_min).toBe(25);
  });

  test("提案のもとにした版が今の版でなければ stale_suggestion（古い提案・二重の承認）", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u);
    const base = await currentVersion(rid);
    await accept(u, rid, { base: base.id });
    const n = await versionCount(rid);
    expect(await errorOf(accept(u, rid, { base: base.id }))).toMatch(/stale_suggestion/);
    expect(await errorOf(accept(u, rid, { rule: "R-03", base: base.id, proposed: JSON.stringify({ weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:00", duration_min: 25 }) }))).toMatch(/stale_suggestion/);
    expect(await errorOf(reject(u, rid, { base: base.id }))).toMatch(/stale_suggestion/);
    // 手動で編集した後も、編集前の版の提案は受け付けない
    const rid2 = await createRoutine(u);
    const b2 = await currentVersion(rid2);
    await db.query("select public._edit_routine($1, $2::timestamptz, $3, 'ストレッチ', 'メモ', '{1,2,3,4,5,6,7}', '06:30', 15, 10, '2026-11-10', null)", [u, NOW, rid2]);
    expect(await errorOf(accept(u, rid2, { base: b2.id }))).toMatch(/stale_suggestion/);
    expect(await versionCount(rid)).toBe(n);
  });

  test("ルールで変えてよい項目以外が変わっている提案・形の違う提案は invalid_input（版は増えない）", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, { weekdays: "{1,2,3}" });
    const base = await currentVersion(rid);
    const bad: [string, unknown][] = [
      ["R-01", { weekdays: [1, 2, 3], start_time: "06:30", duration_min: 15 }], // 早める
      ["R-01", { weekdays: [1, 2, 3], start_time: "07:30", duration_min: 30 }], // 所要時間も変える
      ["R-01", { weekdays: [1, 2, 3], start_time: "07:32", duration_min: 15 }], // 5分単位でない
      ["R-02", { weekdays: [1], start_time: "07:00", duration_min: 15 }], // 2つ外す
      ["R-02", { weekdays: [1, 2, 4], start_time: "07:00", duration_min: 15 }], // 別の曜日を足す
      ["R-02", { weekdays: [1, 2, 3], start_time: "07:00", duration_min: 15 }], // 変わらない
      ["R-03", { weekdays: [1, 2, 3], start_time: "07:00", duration_min: 10 }], // 短くする
      ["R-03", { weekdays: [1, 2, 3], start_time: "07:00", duration_min: 600 }], // 上限を超える
      ["R-03", { weekdays: [1, 2, 3], start_time: "07:00", duration_min: 20.5 }],
      ["R-04", { weekdays: [1, 2, 3], start_time: "07:00", duration_min: 20 }], // 今回は作らないルール
      ["R-01", { weekdays: "1,2,3", start_time: "07:30", duration_min: 15 }],
      ["R-01", { weekdays: [1, 2, 3, 3], start_time: "07:30", duration_min: 15 }],
      ["R-01", { weekdays: [1, 2, 3], start_time: "7:30", duration_min: 15 }],
      ["R-01", { weekdays: [1, 2, 3], start_time: "24:00", duration_min: 15 }],
    ];
    for (const [rule, p] of bad) {
      expect([rule, p, await errorOf(accept(u, rid, { rule, base: base.id, proposed: JSON.stringify(p) }))]).toEqual([rule, p, expect.stringMatching(/invalid_input/)]);
    }
    expect(await errorOf(accept(u, rid, { base: base.id, proposed: JSON.stringify({ weekdays: [1, 2, 3], start_time: "07:30", duration_min: 15 }), evidence: "[]" }))).toMatch(/invalid_input/);
    expect(await versionCount(rid)).toBe(1);
    expect((await db.query("select 1 from public.suggestions where routine_id = $1", [rid])).rows).toEqual([]);
  });

  test("適用開始日は今日〜1年以内（明日が既定。今日も可、昨日は不可）", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u);
    const base = await currentVersion(rid);
    expect(await errorOf(accept(u, rid, { base: base.id, validFrom: "2026-11-08" }))).toMatch(/invalid_valid_from/);
    expect(await versionCount(rid)).toBe(1);
    await accept(u, rid, { base: base.id, validFrom: MON });
    expect((await currentVersion(rid)).valid_from).toBe(MON);
  });

  test("テスト用（分析に含めない）・アーカイブ済み・他人のルーティン・未ログインは拒否", async () => {
    const alice = await createUser(db, "alice");
    const bob = await createUser(db, "bob");
    const rid = await createRoutine(alice);
    const base = await currentVersion(rid);
    expect(await errorOf(accept(bob, rid, { base: base.id }))).toMatch(/not_found/);
    expect(await errorOf(reject(bob, rid, { base: base.id }))).toMatch(/not_found/);
    expect(await errorOf(accept(null as unknown as string, rid, { base: base.id }))).toMatch(/not_authenticated/);
    await db.query("select public._set_routine_analytics($1, now(), $2, true)", [alice, rid]);
    expect(await errorOf(accept(alice, rid, { base: base.id }))).toMatch(/routine_excluded/);
    expect(await errorOf(reject(alice, rid, { base: base.id }))).toMatch(/routine_excluded/);
    await db.query("select public._set_routine_analytics($1, now(), $2, false)", [alice, rid]);
    await db.query("select public._archive_routine($1, $2::timestamptz, $3)", [alice, NOW, rid]);
    expect(await errorOf(accept(alice, rid, { base: base.id }))).toMatch(/routine_archived/);
    expect(await versionCount(rid)).toBe(1);
  });
});

describe("却下（reject_suggestion）と再提案しない期間", () => {
  test("却下は判断だけを記録し、版・予定・イベント・通知ジョブは1つも変えない", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u);
    const base = await currentVersion(rid);
    const before = await recordsOf(rid);
    await reject(u, rid, { base: base.id });
    expect(await recordsOf(rid)).toBe(before);
    const s = await db.query<{ status: string; applied_version_id: string | null }>("select status, applied_version_id from public.suggestions where routine_id = $1", [rid]);
    expect(s.rows).toEqual([{ status: "rejected", applied_version_id: null }]);
  });

  test("同じルーティン・同じルールは却下・承認の日から 28 日間（JST の日付）受け付けない。別のルール・手動の編集は制限しない", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u);
    const base = await currentVersion(rid);
    await reject(u, rid, { base: base.id, now: jst("2026-11-01 23:00") });
    // 27 日後（11/28）までは不可、28 日後（11/29）から可
    expect(await errorOf(reject(u, rid, { base: base.id, now: jst("2026-11-09 08:00") }))).toMatch(/recently_decided/);
    // 同じ版での再判断は、日数に関係なく不可（同じ版・同じルールの判断は1回だけ）
    expect(await errorOf(accept(u, rid, { base: base.id, now: jst("2026-11-29 00:10"), validFrom: "2026-11-30" }))).toMatch(/recently_decided/);

    // 手動の編集はできる。編集後の新しい版に対しても、28 日以内は同じルールを受け付けない
    await db.query("select public._edit_routine($1, $2::timestamptz, $3, 'ストレッチ', 'メモ', '{1,2,3,4,5,6,7}', '06:30', 15, 10, '2026-11-10', null)", [u, NOW, rid]);
    const v2 = await currentVersion(rid);
    const r01 = JSON.stringify({ weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:00", duration_min: 15 });
    expect(await errorOf(accept(u, rid, { base: v2.id, proposed: r01, now: jst("2026-11-28 23:59"), validFrom: "2026-11-29" }))).toMatch(/recently_decided/);
    // 別のルールは受け付ける
    await accept(u, rid, { rule: "R-03", base: v2.id, proposed: JSON.stringify({ weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "06:30", duration_min: 20 }), now: jst("2026-11-20 08:00"), validFrom: "2026-11-21" });
    const v3 = await currentVersion(rid);
    expect(v3.duration_min).toBe(20);
    // 28 日後（11/29 JST）からは R-01 を受け付ける
    await accept(u, rid, { base: v3.id, proposed: JSON.stringify({ weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:00", duration_min: 20 }), now: jst("2026-11-29 00:10"), validFrom: "2026-11-30" });
    expect((await currentVersion(rid)).start_time).toBe("07:00:00");
  });

  test("取り消し（元の設定に戻す）は手動の編集で新しい版を作り、提案から作った版と記録は残る", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u);
    const base = await currentVersion(rid);
    await accept(u, rid, { base: base.id, validFrom: "2026-11-10" });
    const sv = await currentVersion(rid);
    // 同じ日に取り消す：提案の版は「適用前に変更」になり、元の設定の版が同じ日から有効
    await db.query(
      "select public._edit_routine($1, $2::timestamptz, $3, 'ストレッチ', 'メモ', '{1,2,3,4,5,6,7}', '07:00', 15, 10, '2026-11-10', '提案 R-01 の取り消し')",
      [u, jst(`${MON} 21:30`), rid],
    );
    const v3 = await currentVersion(rid);
    expect(v3).toMatchObject({ version_no: 3, start_time: "07:00:00", source: "manual", suggestion_id: null, change_reason: "提案 R-01 の取り消し" });
    const all = await db.query<{ version_no: number; source: string; valid_from: string; valid_to: string | null }>(
      "select version_no, source, valid_from::text, valid_to::text from public.routine_versions where routine_id = $1 order by version_no",
      [rid],
    );
    expect(all.rows).toEqual([
      { version_no: 1, source: "manual", valid_from: MON, valid_to: "2026-11-10" },
      { version_no: 2, source: "suggestion", valid_from: "2026-11-10", valid_to: "2026-11-10" },
      { version_no: 3, source: "manual", valid_from: "2026-11-10", valid_to: null },
    ]);
    expect((await db.query("select id from public.suggestions where applied_version_id = $1", [sv.id])).rows).toHaveLength(1);
    // 明日の予定は元の時刻に戻り、送信待ちの通知は1つだけ
    const jobs = await db.query<{ fire_at: string }>(
      "select j.fire_at::text from public.notification_jobs j join public.occurrences o on o.id = j.occurrence_id where o.routine_id = $1 and o.planned_date = '2026-11-10' and j.status = 'pending'",
      [rid],
    );
    expect(jobs.rows).toEqual([{ fire_at: "2026-11-09 22:00:00+00" }]);
  });
});

describe("記録の守り（RLS・変更不可）", () => {
  test("本人だけが読め、画面から直接は書けず、作成後は変更・削除できない", async () => {
    const alice = await createUser(db, "alice");
    const bob = await createUser(db, "bob");
    const rid = await createRoutine(alice);
    const base = await currentVersion(rid);
    await as(db, "authenticated", alice, (tx) =>
      tx.query("select public.reject_suggestion($1, 'R-01', $2, $3::jsonb, $4::jsonb)", [rid, base.id, EVIDENCE, R01]),
    );
    const mine = await as(db, "authenticated", alice, (tx) => tx.query("select id from public.suggestions where routine_id = $1", [rid]));
    expect(mine.rows).toHaveLength(1);
    const theirs = await as(db, "authenticated", bob, (tx) => tx.query("select id from public.suggestions"));
    expect(theirs.rows).toEqual([]);
    expect(await errorOf(as(db, "anon", null, (tx) => tx.query("select id from public.suggestions")))).toMatch(/permission denied/);
    expect(await errorOf(as(db, "anon", null, (tx) => tx.query("select public.reject_suggestion($1, 'R-01', $2, '{}'::jsonb, $3::jsonb)", [rid, base.id, R01])))).toMatch(/permission denied/);
    for (const sql of [
      "insert into public.suggestions (user_id, routine_id, rule_id, base_version_id, evidence, current_settings, proposed, status, decided_at) values ($1, $2, 'R-01', $3, '{}', '{}', '{}', 'rejected', now())",
      "update public.suggestions set status = 'accepted' where routine_id = $2 and $1::uuid is not null and $3::uuid is not null",
      "delete from public.suggestions where routine_id = $2 and $1::uuid is not null and $3::uuid is not null",
    ]) {
      expect(await errorOf(as(db, "authenticated", alice, (tx) => tx.query(sql, [alice, rid, base.id])))).toMatch(/permission denied/);
    }
    // 権限を持つ管理者（service_role）でも、記録の変更・削除はトリガーが止める
    expect(await errorOf(db.query("update public.suggestions set status = 'accepted' where routine_id = $1", [rid]))).toMatch(/変更できません/);
    expect(await errorOf(db.query("delete from public.suggestions where routine_id = $1", [rid]))).toMatch(/削除できません/);
    // 内部の関数は画面から呼べない
    expect(await errorOf(as(db, "authenticated", alice, (tx) => tx.query("select public._reject_suggestion($1, now(), $2, 'R-01', $3, '{}'::jsonb, $4::jsonb)", [alice, rid, base.id, R01])))).toMatch(/permission denied/);
  });

  test("版の「きっかけ」と提案のつながりは DB の制約で守る（提案なしの suggestion・提案ありの manual は作れない）", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u);
    expect(await errorOf(db.query(
      "select public._apply_routine_version($1, $2::timestamptz, $3, 'x', null, '{1}', '08:00', 15, 10, '2026-11-10', null, 'suggestion', null)",
      [u, NOW, rid],
    ))).toMatch(/invalid_input/);
    expect(await errorOf(db.query(
      "select public._apply_routine_version($1, $2::timestamptz, $3, 'x', null, '{1}', '08:00', 15, 10, '2026-11-10', null, 'manual', gen_random_uuid())",
      [u, NOW, rid],
    ))).toMatch(/invalid_input/);
    // 存在しない提案につないだ版は、トランザクションの終わりで外部キーが止める
    expect(await errorOf(db.transaction(async (tx) => {
      await tx.query(
        "select public._apply_routine_version($1, $2::timestamptz, $3, 'x', null, '{1}', '08:00', 15, 10, '2026-11-10', null, 'suggestion', gen_random_uuid())",
        [u, NOW, rid],
      );
    }))).toMatch(/routine_versions_suggestion_fk/);
    expect(await versionCount(rid)).toBe(1);
  });

  test("手動の編集（edit_routine）は今までどおり：きっかけ＝手動、画面からも呼べる", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u);
    await as(db, "authenticated", u, (tx) =>
      tx.query("select public.edit_routine($1, 'ストレッチ', 'メモ', '{1,2,3}', '08:00', 20, 10, current_date + 1, '朝が忙しい')", [rid]),
    );
    expect(await currentVersion(rid)).toMatchObject({ version_no: 2, source: "manual", suggestion_id: null, start_time: "08:00:00", duration_min: 20 });
  });
});
