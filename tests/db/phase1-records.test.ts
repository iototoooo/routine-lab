// Phase 1：予定の作成・編集・記録・未実施・アーカイブ・分析ビュー（docs/phase1-plan.md 2章・5章）
// 時刻は内部の関数（_create_routine など）に引数で渡して固定する。画面からの入口（auth.uid() / now()）は rls テストで確認する。

import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, createUser, errorOf, jst } from "./harness";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});

// 2026-11-10 は火曜日（ISO 2）
const TUE = "2026-11-10";
const WED = "2026-11-11";

type Occ = {
  id: string;
  planned_date: string;
  planned_start_at: string;
  planned_duration_min: number;
  status: string;
  routine_version_id: string;
  next_remind_at: string | null;
  postpone_count: number;
  closed_at: string | null;
};

async function createRoutine(
  user: string,
  now: string,
  opts: Partial<{ name: string; weekdays: number[]; start: string; duration: number; snooze: number }> = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    "select public._create_routine($1, $2::timestamptz, $3, null, $4::integer[], $5::time, $6, $7) as id",
    [user, now, opts.name ?? "朝のストレッチ", opts.weekdays ?? [1, 2, 3, 4, 5, 6, 7], opts.start ?? "07:00", opts.duration ?? 15, opts.snooze ?? 10],
  );
  return r.rows[0]!.id;
}

async function occurrences(routineId: string): Promise<Occ[]> {
  const r = await db.query<Occ>(
    `select id, planned_date::text, planned_start_at::text, planned_duration_min, status, routine_version_id,
            next_remind_at::text, postpone_count, closed_at::text
       from public.occurrences where routine_id = $1 order by planned_date`,
    [routineId],
  );
  return r.rows;
}
async function occOn(routineId: string, date: string): Promise<Occ> {
  const o = (await occurrences(routineId)).find((x) => x.planned_date === date);
  if (!o) throw new Error(`${date} の予定がありません`);
  return o;
}
async function events(occId: string) {
  const r = await db.query<{
    type: string; from_status: string | null; to_status: string | null; remind_at: string | null;
    postpone_option: string | null; reason_code: string | null; reason_text: string | null;
    actor: string; detail: Record<string, unknown> | null; execution_id: string | null;
  }>(
    `select type, from_status, to_status, remind_at::text, postpone_option, reason_code, reason_text, actor, detail, execution_id
       from public.occurrence_events where occurrence_id = $1 order by id`,
    [occId],
  );
  return r.rows;
}
async function versions(routineId: string) {
  const r = await db.query<{ id: string; version_no: number; valid_from: string; valid_to: string | null; start_time: string; weekdays: number[]; change_reason: string | null }>(
    `select id, version_no, valid_from::text, valid_to::text, start_time::text, weekdays, change_reason
       from public.routine_versions where routine_id = $1 order by version_no`,
    [routineId],
  );
  return r.rows;
}
const recordDone = (user: string, now: string, occ: string, start: string, dur: number, src = "manual") =>
  db.query("select public._record_done($1, $2::timestamptz, $3, $4::timestamptz, $5, $6) as id", [user, now, occ, start, dur, src]);
const postpone = (user: string, now: string, occ: string, option: string, remindAt: string | null = null, code: string | null = null, text: string | null = null) =>
  db.query<{ r: string }>("select public._postpone($1, $2::timestamptz, $3, $4, $5::timestamptz, $6, $7)::text as r", [user, now, occ, option, remindAt, code, text]);
const skip = (user: string, now: string, occ: string, code: string | null, text: string | null = null) =>
  db.query("select public._skip($1, $2::timestamptz, $3, $4, $5)", [user, now, occ, code, text]);
const edit = (
  user: string, now: string, routine: string,
  o: Partial<{ name: string; weekdays: number[]; start: string; duration: number; snooze: number; validFrom: string; reason: string | null }> = {},
) =>
  db.query<{ id: string }>(
    "select public._edit_routine($1, $2::timestamptz, $3, $4, null, $5::integer[], $6::time, $7, $8, $9::date, $10) as id",
    [user, now, routine, o.name ?? "朝のストレッチ", o.weekdays ?? [1, 2, 3, 4, 5, 6, 7], o.start ?? "07:00", o.duration ?? 15, o.snooze ?? 10, o.validFrom ?? TUE, o.reason ?? null],
  );
const utc = (s: string) => new Date(s).toISOString();

describe("予定の作成（F-201〜203）", () => {
  test("登録すると今日と明日の予定ができ、版の設定が写される", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "07:00", duration: 15 });
    const occ = await occurrences(rid);
    expect(occ.map((o) => o.planned_date)).toEqual([TUE, WED]);
    expect(utc(occ[0]!.planned_start_at)).toBe("2026-11-09T22:00:00.000Z"); // 7:00 JST = 22:00 UTC（前日）
    expect(occ[0]!.planned_duration_min).toBe(15);
    expect(occ[0]!.status).toBe("scheduled");
    const v = await versions(rid);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ version_no: 1, valid_from: TUE, valid_to: null });
    expect(occ.every((o) => o.routine_version_id === v[0]!.id)).toBe(true);
  });

  test("判断事項1：開始時刻を過ぎてから登録したら、今日の予定は作らない（明日は作る）", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 08:00`), { start: "07:00" });
    expect((await occurrences(rid)).map((o) => o.planned_date)).toEqual([WED]);
  });

  test("何度呼んでも重複しない（F-202）", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`));
    const again = await db.query<{ n: number }>("select public._ensure_occurrences($1, $2::timestamptz) as n", [u, jst(`${TUE} 06:30`)]);
    expect(again.rows[0]!.n).toBe(0);
    expect(await occurrences(rid)).toHaveLength(2);
  });

  test("曜日の設定に従う（月曜だけなら火・水には作らない）", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { weekdays: [1] });
    expect(await occurrences(rid)).toHaveLength(0);
  });

  test("0:00 JST の境界：23:59:59 は火曜、0:00 は水曜として今日・明日を決める", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "07:00" });
    // 火曜 23:59:59（UTC 14:59:59）：火・水はもうある
    let n = await db.query<{ n: number }>("select public._ensure_occurrences($1, '2026-11-10T14:59:59Z') as n", [u]);
    expect(n.rows[0]!.n).toBe(0);
    // 水曜 0:00（UTC 15:00）：木曜が増える
    n = await db.query<{ n: number }>("select public._ensure_occurrences($1, '2026-11-10T15:00:00Z') as n", [u]);
    expect(n.rows[0]!.n).toBe(1);
    expect((await occurrences(rid)).map((o) => o.planned_date)).toEqual([TUE, WED, "2026-11-12"]);
  });

  test("23:30 開始・60分の予定は、開始日が予定日になる", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "23:30", duration: 60 });
    const o = await occOn(rid, TUE);
    expect(utc(o.planned_start_at)).toBe("2026-11-10T14:30:00.000Z");
  });

  test("年末：12/31 の明日は翌年 1/1", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst("2026-12-31 06:00"));
    expect((await occurrences(rid)).map((o) => o.planned_date)).toEqual(["2026-12-31", "2027-01-01"]);
  });

  test("入力の検査（名前・曜日・5分単位・所要時間）", async () => {
    const u = await createUser(db);
    const bad = async (o: Parameters<typeof createRoutine>[2]) => errorOf(createRoutine(u, jst(`${TUE} 06:00`), o));
    expect(await bad({ name: "あ".repeat(41) })).toMatch(/invalid_input/);
    expect(await bad({ name: "   " })).toMatch(/invalid_input/);
    expect(await bad({ weekdays: [] })).toMatch(/invalid_input/);
    expect(await bad({ weekdays: [0] })).toMatch(/invalid_input/);
    expect(await bad({ weekdays: [8] })).toMatch(/invalid_input/);
    expect(await bad({ start: "07:03" })).toMatch(/invalid_input|check constraint/);
    expect(await bad({ duration: 4 })).toMatch(/invalid_input/);
    expect(await bad({ duration: 481 })).toMatch(/invalid_input/);
    // 曜日は並べ替え・重複除去して保存する
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { weekdays: [3, 1, 3] });
    expect((await versions(rid))[0]!.weekdays).toEqual([1, 3]);
  });
});

describe("編集（F-102）：過去の予定・実績を変えない", () => {
  test("今日から適用：まだ始まっていない今日の予定は新しい版に合わせ、編集イベントに前後の値を残す", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "07:00" });
    const before = await occOn(rid, TUE);
    const vid = (await edit(u, jst(`${TUE} 06:10`), rid, { start: "08:00", reason: "朝は混むため" })).rows[0]!.id;
    const after = await occOn(rid, TUE);
    expect(after.id).toBe(before.id);
    expect(after.routine_version_id).toBe(vid);
    expect(utc(after.planned_start_at)).toBe("2026-11-09T23:00:00.000Z");
    const ev = await events(after.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("edited");
    expect((ev[0]!.detail as { from: { planned_start_at: string } }).from.planned_start_at).toBeTruthy();
    const v = await versions(rid);
    // 同じ日に適用した前の版は「一度も有効にならなかった」ではなく、今日の 0 時で閉じる（[TUE, TUE) は空）
    expect(v.map((x) => [x.version_no, x.valid_from, x.valid_to, x.start_time])).toEqual([
      [1, TUE, TUE, "07:00:00"],
      [2, TUE, null, "08:00:00"],
    ]);
    expect(v[1]!.change_reason).toBe("朝は混むため");
  });

  test("判断事項1：開始時刻を過ぎた今日の予定は前の版のまま残し、明日から新しい版", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "07:00" });
    const v1 = (await versions(rid))[0]!.id;
    await edit(u, jst(`${TUE} 07:30`), rid, { start: "09:00" });
    const today = await occOn(rid, TUE);
    expect(today.routine_version_id).toBe(v1);
    expect(utc(today.planned_start_at)).toBe("2026-11-09T22:00:00.000Z");
    const tomorrow = await occOn(rid, WED);
    expect(utc(tomorrow.planned_start_at)).toBe("2026-11-11T00:00:00.000Z"); // 水 9:00 JST
  });

  test("新しい開始時刻がもう過ぎているなら、今日の予定は作り直さずに取り消す", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "10:00" });
    await edit(u, jst(`${TUE} 09:00`), rid, { start: "08:00" });
    const today = await occOn(rid, TUE);
    expect(today.status).toBe("cancelled");
    expect((await events(today.id))[0]).toMatchObject({ type: "cancelled", detail: { cause: "edited" } });
  });

  test("曜日から外れた明日の予定は取り消す（削除しない）", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { weekdays: [2, 3] });
    await edit(u, jst(`${TUE} 06:10`), rid, { weekdays: [2] });
    expect((await occOn(rid, WED)).status).toBe("cancelled");
    expect((await occOn(rid, TUE)).status).toBe("scheduled");
  });

  test("明日から適用：今日の予定は前の版のまま", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "07:00" });
    const v1 = (await versions(rid))[0]!.id;
    await edit(u, jst(`${TUE} 06:10`), rid, { start: "08:00", validFrom: WED });
    expect((await occOn(rid, TUE)).routine_version_id).toBe(v1);
    expect(utc((await occOn(rid, WED)).planned_start_at)).toBe("2026-11-10T23:00:00.000Z");
    expect((await versions(rid)).map((x) => [x.valid_from, x.valid_to])).toEqual([[TUE, WED], [WED, null]]);
  });

  test("記録済み・延期中の予定は編集しても変わらない", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "07:00" });
    const today = await occOn(rid, TUE);
    const tomorrow = await occOn(rid, WED);
    await recordDone(u, jst(`${TUE} 06:30`), today.id, jst(`${TUE} 06:00`), 15);
    await postpone(u, jst(`${TUE} 06:30`), tomorrow.id, "1h");
    await edit(u, jst(`${TUE} 06:40`), rid, { start: "08:00" });
    const t2 = await occOn(rid, TUE);
    const w2 = await occOn(rid, WED);
    expect([t2.status, t2.routine_version_id, t2.planned_start_at]).toEqual(["done", today.routine_version_id, today.planned_start_at]);
    expect([w2.status, w2.routine_version_id, w2.planned_start_at]).toEqual(["postponed", tomorrow.routine_version_id, tomorrow.planned_start_at]);
  });

  test("過去の適用開始日・変更なし・他人のルーティンは拒否", async () => {
    const u = await createUser(db);
    const other = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`));
    expect(await errorOf(edit(u, jst(`${TUE} 06:10`), rid, { start: "08:00", validFrom: "2026-11-09" }))).toMatch(/invalid_valid_from/);
    expect(await errorOf(edit(u, jst(`${TUE} 06:10`), rid))).toMatch(/no_change/);
    expect(await errorOf(edit(other, jst(`${TUE} 06:10`), rid, { start: "08:00" }))).toMatch(/not_found/);
  });

  test("版は変更も削除もできない（DB の中でも守る）。重なる有効期間も作れない", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`));
    const v = (await versions(rid))[0]!;
    expect(await errorOf(db.query("update public.routine_versions set duration_min = 30 where id = $1", [v.id]))).toMatch(/変更できません/);
    expect(await errorOf(db.query("delete from public.routine_versions where id = $1", [v.id]))).toMatch(/削除できません/);
    expect(
      await errorOf(
        db.query(
          `insert into public.routine_versions (user_id, routine_id, version_no, name, weekdays, start_time, duration_min, snooze_min, valid_from)
           values ($1, $2, 2, 'x', '{1}', '07:00', 15, 10, '2026-12-01')`,
          [u, rid],
        ),
      ),
    ).toMatch(/exclusion|routine_versions_no_overlap/);
  });
});

describe("記録（F-402〜405）", () => {
  test("完了：実績を追加し、予定は done、イベントに実績を結ぶ。予定時刻と実行時刻は別の列", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "07:00", duration: 15 });
    const o = await occOn(rid, TUE);
    await recordDone(u, jst(`${TUE} 07:40`), o.id, jst(`${TUE} 07:12`), 20, "manual");
    const e = await db.query<{ actual_start_at: string; actual_end_at: string; executed_date: string; is_late_day: boolean; start_source: string }>(
      "select actual_start_at::text, actual_end_at::text, executed_date::text, is_late_day, start_source from public.executions where occurrence_id = $1",
      [o.id],
    );
    expect(e.rows).toHaveLength(1);
    expect(utc(e.rows[0]!.actual_start_at)).toBe("2026-11-09T22:12:00.000Z");
    expect(utc(e.rows[0]!.actual_end_at)).toBe("2026-11-09T22:32:00.000Z");
    expect(e.rows[0]).toMatchObject({ executed_date: TUE, is_late_day: false, start_source: "manual" });
    const after = await occOn(rid, TUE);
    expect(after.status).toBe("done");
    expect(after.planned_start_at).toBe(o.planned_start_at); // 予定時刻は変わらない
    const ev = await events(o.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "done", from_status: "scheduled", to_status: "done" });
    expect(ev[0]!.execution_id).toBeTruthy();
  });

  test("翌日に実施：予定日は変えず、is_late_day = true", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "21:00" });
    const o = await occOn(rid, TUE);
    await recordDone(u, jst(`${WED} 08:00`), o.id, jst(`${WED} 07:30`), 15, "manual");
    const e = await db.query<{ planned_date: string; executed_date: string; is_late_day: boolean }>(
      "select planned_date::text, executed_date::text, is_late_day from public.executions where occurrence_id = $1",
      [o.id],
    );
    expect(e.rows[0]).toEqual({ planned_date: TUE, executed_date: WED, is_late_day: true });
  });

  test("開始時刻の検査：予定日より前・未来は拒否、二重の記録も拒否", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`));
    const o = await occOn(rid, TUE);
    expect(await errorOf(recordDone(u, jst(`${TUE} 08:00`), o.id, jst("2026-11-09 23:59"), 15))).toMatch(/invalid_start/);
    expect(await errorOf(recordDone(u, jst(`${TUE} 08:00`), o.id, jst(`${TUE} 08:30`), 15))).toMatch(/invalid_start/);
    expect(await errorOf(recordDone(u, jst(`${TUE} 08:00`), o.id, jst(`${TUE} 07:00`), 0))).toMatch(/invalid_input/);
    await recordDone(u, jst(`${TUE} 08:00`), o.id, jst(`${TUE} 07:00`), 15, "planned");
    expect(await errorOf(recordDone(u, jst(`${TUE} 08:01`), o.id, jst(`${TUE} 07:00`), 15))).toMatch(/occurrence_closed/);
  });

  test("延期：予定時刻は変えずに再通知の時刻を保存。何回でも延期でき、すべてイベントに残る", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "07:00" });
    const o = await occOn(rid, TUE);
    const r1 = await postpone(u, jst(`${TUE} 07:02:30`), o.id, "10m", null, "tired", "眠い");
    expect(utc(r1.rows[0]!.r)).toBe("2026-11-09T22:12:00.000Z"); // 7:02 の10分後（分に切り捨て）
    await postpone(u, jst(`${TUE} 07:15`), o.id, "30m", null, "no_time");
    let cur = await occOn(rid, TUE);
    expect(cur).toMatchObject({ status: "postponed", postpone_count: 2 });
    expect(utc(cur.next_remind_at!)).toBe("2026-11-09T22:45:00.000Z");
    expect(cur.planned_start_at).toBe(o.planned_start_at);
    await recordDone(u, jst(`${TUE} 08:00`), o.id, jst(`${TUE} 07:45`), 15, "manual");
    cur = await occOn(rid, TUE);
    expect(cur).toMatchObject({ status: "done", next_remind_at: null, postpone_count: 2 });
    const ev = await events(o.id);
    expect(ev.map((e) => [e.type, e.postpone_option, e.reason_code])).toEqual([
      ["postponed", "10m", "tired"],
      ["postponed", "30m", "no_time"],
      ["done", null, null],
    ]);
    expect(ev[0]!.reason_text).toBe("眠い");
    expect(ev[1]!.from_status).toBe("postponed");
  });

  test("延期の時刻：明日の同じ時刻・今日の指定時刻。期限（予定日の翌日の終わり）を越えるものは拒否", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "07:00" });
    const o = await occOn(rid, TUE);
    const r = await postpone(u, jst(`${TUE} 07:05`), o.id, "tomorrow_same");
    expect(utc(r.rows[0]!.r)).toBe("2026-11-10T22:00:00.000Z"); // 水 7:00 JST
    // 翌日（水）に、火曜の予定を「明日の同じ時刻」＝木曜にはできない（期限は水曜の終わり）
    expect(await errorOf(postpone(u, jst(`${WED} 07:30`), o.id, "tomorrow_same"))).toMatch(/invalid_remind_at/);
    // 今日の指定時刻：過去・別の日は拒否、今日の未来なら可
    expect(await errorOf(postpone(u, jst(`${WED} 07:30`), o.id, "today_at", jst(`${WED} 07:00`)))).toMatch(/invalid_remind_at/);
    expect(await errorOf(postpone(u, jst(`${WED} 07:30`), o.id, "today_at", jst("2026-11-12 07:00")))).toMatch(/invalid_remind_at/);
    const ok = await postpone(u, jst(`${WED} 07:30`), o.id, "today_at", jst(`${WED} 21:15`));
    expect(utc(ok.rows[0]!.r)).toBe("2026-11-11T12:15:00.000Z");
    // 23:55 の「1時間後」は期限を越える
    expect(await errorOf(postpone(u, jst(`${WED} 23:30`), o.id, "1h"))).toMatch(/invalid_remind_at/);
    expect(await errorOf(postpone(u, jst(`${WED} 07:30`), o.id, "2h"))).toMatch(/invalid_input/);
    expect(await errorOf(postpone(u, jst(`${WED} 07:30`), o.id, "10m", null, null, "理由だけ"))).toMatch(/invalid_input/);
  });

  test("見送り：理由（選択）は必須。自由記述も残る", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`));
    const o = await occOn(rid, TUE);
    expect(await errorOf(skip(u, jst(`${TUE} 07:30`), o.id, null))).toMatch(/reason_required/);
    expect(await errorOf(skip(u, jst(`${TUE} 07:30`), o.id, "lazy"))).toMatch(/invalid_input/);
    await skip(u, jst(`${TUE} 07:30`), o.id, "sick", "熱がある");
    expect((await occOn(rid, TUE)).status).toBe("skipped");
    expect((await events(o.id))[0]).toMatchObject({ type: "skipped", reason_code: "sick", reason_text: "熱がある" });
  });

  test("他人の予定は記録・延期・見送りできない（存在も分からない not_found）", async () => {
    const u = await createUser(db);
    const other = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`));
    const o = await occOn(rid, TUE);
    expect(await errorOf(recordDone(other, jst(`${TUE} 08:00`), o.id, jst(`${TUE} 07:00`), 15))).toMatch(/not_found/);
    expect(await errorOf(postpone(other, jst(`${TUE} 08:00`), o.id, "10m"))).toMatch(/not_found/);
    expect(await errorOf(skip(other, jst(`${TUE} 08:00`), o.id, "other"))).toMatch(/not_found/);
    expect((await occOn(rid, TUE)).status).toBe("scheduled");
  });

  test("実績とイベントは変更・削除できない。予定も削除できない", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`));
    const o = await occOn(rid, TUE);
    await recordDone(u, jst(`${TUE} 08:00`), o.id, jst(`${TUE} 07:00`), 15);
    expect(await errorOf(db.query("update public.executions set actual_duration_min = 99 where occurrence_id = $1", [o.id]))).toMatch(/変更できません/);
    expect(await errorOf(db.query("delete from public.executions where occurrence_id = $1", [o.id]))).toMatch(/削除できません/);
    expect(await errorOf(db.query("update public.occurrence_events set reason_code = 'other' where occurrence_id = $1", [o.id]))).toMatch(/変更できません/);
    expect(await errorOf(db.query("delete from public.occurrences where id = $1", [o.id]))).toMatch(/削除できません/);
  });
});

describe("未実施の自動確定（F-406）", () => {
  test("予定日の翌日の終わり（JST 24:00）を過ぎたら missed。直前はまだ記録できる", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { weekdays: [2, 3], start: "07:00" });
    const tue = await occOn(rid, TUE);
    const wed = await occOn(rid, WED);
    await postpone(u, jst(`${WED} 20:00`), tue.id, "1h");
    await recordDone(u, jst(`${WED} 08:00`), wed.id, jst(`${WED} 07:00`), 15);
    // 木曜 0:00 の 1 秒前：まだ確定しない
    let n = await db.query<{ n: number }>("select public._close_missed($1, '2026-11-11T14:59:59Z') as n", [u]);
    expect(n.rows[0]!.n).toBe(0);
    // 木曜 0:00：火曜の延期中の予定が missed（水曜の完了はそのまま）
    n = await db.query<{ n: number }>("select public._close_missed($1, '2026-11-11T15:00:00Z') as n", [u]);
    expect(n.rows[0]!.n).toBe(1);
    expect((await occOn(rid, TUE)).status).toBe("missed");
    expect((await occOn(rid, TUE)).next_remind_at).toBeNull();
    expect((await occOn(rid, WED)).status).toBe("done");
    expect((await events(tue.id)).at(-1)).toMatchObject({ type: "missed", from_status: "postponed", actor: "system" });
    // 期限を過ぎたら記録もできない
    expect(await errorOf(skip(u, "2026-11-11T15:00:00Z", tue.id, "forgot"))).toMatch(/occurrence_closed/);
  });
});

describe("アーカイブ（F-103）", () => {
  test("判断事項2：開始時刻を過ぎた今日の予定は残し、まだ始まっていない予定は取り消す。以後は作らない", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 06:00`), { start: "07:00" });
    const n = await db.query<{ n: number }>("select public._archive_routine($1, $2::timestamptz, $3) as n", [u, jst(`${TUE} 07:30`), rid]);
    expect(n.rows[0]!.n).toBe(1);
    expect((await occOn(rid, TUE)).status).toBe("scheduled");
    const wed = await occOn(rid, WED);
    expect(wed.status).toBe("cancelled");
    expect((await events(wed.id))[0]).toMatchObject({ type: "cancelled", detail: { cause: "archived" } });
    // 残した今日の予定は記録できる
    await recordDone(u, jst(`${TUE} 07:40`), (await occOn(rid, TUE)).id, jst(`${TUE} 07:20`), 15);
    // 翌日以降は作らない
    await db.query("select public._ensure_occurrences($1, '2026-11-11T15:00:00Z')", [u]);
    expect((await occurrences(rid)).map((o) => o.planned_date)).toEqual([TUE, WED]);
    expect(await errorOf(edit(u, jst(`${TUE} 08:00`), rid, { start: "08:00" }))).toMatch(/routine_archived/);
  });
});

describe("分析用のビュー occurrence_facts（Phase 3・4 の土台）", () => {
  test("遅延・所要時間の比・曜日・時間帯・最終結果・理由を1行で取れる", async () => {
    const u = await createUser(db);
    const rid = await createRoutine(u, jst(`${TUE} 05:00`), { weekdays: [2, 3], start: "07:00", duration: 20 });
    const tue = await occOn(rid, TUE);
    const wed = await occOn(rid, WED);
    await postpone(u, jst(`${TUE} 07:05`), tue.id, "30m", null, "tired");
    await recordDone(u, jst(`${TUE} 08:00`), tue.id, jst(`${TUE} 07:35`), 25);
    await skip(u, jst(`${WED} 06:00`), wed.id, "plans");
    const f = await db.query<Record<string, unknown>>(
      `select planned_date::text, planned_weekday, time_band, is_final, status, delay_min, duration_ratio::text,
              postpone_count, is_late_day, closing_reason_code, version_no
         from public.occurrence_facts where routine_id = $1 order by planned_date`,
      [rid],
    );
    expect(f.rows).toEqual([
      { planned_date: TUE, planned_weekday: 2, time_band: "morning", is_final: true, status: "done", delay_min: 35, duration_ratio: "1.250", postpone_count: 1, is_late_day: false, closing_reason_code: null, version_no: 1 },
      { planned_date: WED, planned_weekday: 3, time_band: "morning", is_final: true, status: "skipped", delay_min: null, duration_ratio: null, postpone_count: 0, is_late_day: null, closing_reason_code: "plans", version_no: 1 },
    ]);
  });

  test("時間帯の境界（要件 F-505）は画面側の timeBand と同じ", async () => {
    const { timeBand } = await import("@/lib/time/bands");
    const u = await createUser(db);
    for (const t of ["03:55", "04:00", "06:55", "07:00", "09:55", "10:00", "13:55", "14:00", "17:55", "18:00", "21:55", "22:00", "00:00"]) {
      const rid = await createRoutine(u, jst("2026-11-09 00:00"), { start: t, name: `t${t}` });
      const r = await db.query<{ time_band: string }>(
        "select time_band from public.occurrence_facts where routine_id = $1 and planned_date = '2026-11-10'",
        [rid],
      );
      expect([t, r.rows[0]!.time_band]).toEqual([t, timeBand(t)]);
    }
  });
});
