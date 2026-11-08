// ブラウザテスト用の「偽の Supabase」。https://e2e-test.supabase.co への通信をすべて横取りし、
// メモリ上のデータで PostgREST / RPC の応答を返す。画面が送った RPC の引数は calls に残して、テストで確かめる。
// 規則の正しさ（RLS・版・期限など）は tests/db で本物の PostgreSQL を使って確かめている。ここは画面の流れの確認用。

import type { Page, Route } from "@playwright/test";

export const SUPABASE_URL = "https://e2e-test.supabase.co";
export const STORAGE_KEY = "sb-e2e-test-auth-token";
export const USER_ID = "11111111-1111-4111-8111-111111111111";
/** テストの「今」：2026-11-10（火）7:30 JST */
export const NOW = new Date("2026-11-10T07:30:00+09:00");
export const TODAY = "2026-11-10";

type Row = Record<string, unknown>;
export type Call = { fn: string; body: Row };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDS = {
  routineStretch: id(1),
  routineReading: id(2),
  v1Stretch: id(11),
  v1Reading: id(12),
  occYesterday: id(21),
  occToday: id(22),
  occTonight: id(23),
  occTomorrow: id(24),
};

const jstIso = (date: string, time: string) => new Date(`${date}T${time}:00+09:00`).toISOString();

export class FakeSupabase {
  calls: Call[] = [];
  tables: Record<string, Row[]> = {
    routines: [
      { id: IDS.routineStretch, user_id: USER_ID, name: "朝のストレッチ", note: null, archived_at: null, created_at: "2026-11-01T00:00:00Z" },
      { id: IDS.routineReading, user_id: USER_ID, name: "夜の読書", note: "寝る前に", archived_at: null, created_at: "2026-11-01T00:01:00Z" },
    ],
    routine_versions: [
      { id: IDS.v1Stretch, routine_id: IDS.routineStretch, version_no: 1, name: "朝のストレッチ", note: null, weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:00:00", duration_min: 15, snooze_min: 10, valid_from: "2026-11-01", valid_to: null, change_reason: null, source: "manual", created_at: "2026-11-01T00:00:00Z" },
      { id: IDS.v1Reading, routine_id: IDS.routineReading, version_no: 1, name: "夜の読書", note: "寝る前に", weekdays: [1, 2, 3, 4, 5], start_time: "21:00:00", duration_min: 30, snooze_min: 10, valid_from: "2026-11-01", valid_to: null, change_reason: null, source: "manual", created_at: "2026-11-01T00:01:00Z" },
    ],
    occurrences: [
      this.occ(IDS.occYesterday, IDS.routineStretch, IDS.v1Stretch, "2026-11-09", "07:00", 15),
      this.occ(IDS.occToday, IDS.routineStretch, IDS.v1Stretch, TODAY, "07:00", 15),
      this.occ(IDS.occTonight, IDS.routineReading, IDS.v1Reading, TODAY, "21:00", 30),
      this.occ(IDS.occTomorrow, IDS.routineStretch, IDS.v1Stretch, "2026-11-11", "07:00", 15),
    ],
    executions: [],
    occurrence_events: [],
    // Phase 2：今日 7:00 の通知は送信済み、今夜 21:00 と明日 7:00 は送信待ち
    notification_jobs: [
      { occurrence_id: IDS.occToday, kind: "initial", fire_at: jstIso(TODAY, "07:00"), status: "sent", sent_at: jstIso(TODAY, "07:00") },
      { occurrence_id: IDS.occTonight, kind: "initial", fire_at: jstIso(TODAY, "21:00"), status: "pending", sent_at: null },
      { occurrence_id: IDS.occTomorrow, kind: "initial", fire_at: jstIso("2026-11-11", "07:00"), status: "pending", sent_at: null },
    ],
  };

  occ(oid: string, rid: string, vid: string, date: string, time: string, dur: number): Row {
    return {
      id: oid, routine_id: rid, routine_version_id: vid, planned_date: date, planned_start_at: jstIso(date, time),
      planned_duration_min: dur, status: "scheduled", next_remind_at: null, postpone_count: 0, closed_at: null,
    };
  }

  lastCall(fn: string): Row | undefined {
    return [...this.calls].reverse().find((c) => c.fn === fn)?.body;
  }

  async install(page: Page, { loggedIn = true } = {}) {
    await page.clock.setFixedTime(NOW);
    if (loggedIn) {
      const session = {
        access_token: "e2e.e30.signature",
        refresh_token: "e2e-refresh",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(new Date("2030-01-01T00:00:00Z").getTime() / 1000),
        user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "e2e@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-11-01T00:00:00Z" },
      };
      await page.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [STORAGE_KEY, JSON.stringify(session)] as const);
    }
    await page.route(`${SUPABASE_URL}/**`, (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    }
    if (url.pathname.startsWith("/auth/v1/")) return json(200, {});
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (rpc) {
      const body = (req.postDataJSON() ?? {}) as Row;
      this.calls.push({ fn: rpc[1]!, body });
      const r = this.rpc(rpc[1]!, body);
      return "error" in r ? json(400, { message: r.error, code: "22023" }) : json(200, r.data);
    }
    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (table && req.method() === "GET" && this.tables[table]) return json(200, this.select(table, url.searchParams));
    return json(404, { message: "not handled in fake" });
  }

  private select(table: string, params: URLSearchParams): Row[] {
    let rows = [...this.tables[table]!];
    let order: [string, boolean] | null = null;
    for (const [k, v] of params) {
      if (k === "select") continue;
      if (k === "order") {
        const [col, dir] = v.split(".");
        order = [col!, dir !== "desc"];
        continue;
      }
      const [op, ...rest] = v.split(".");
      const arg = rest.join(".");
      if (op === "eq") rows = rows.filter((r) => String(r[k]) === arg);
      else if (op === "gte") rows = rows.filter((r) => String(r[k]) >= arg);
      else if (op === "in") {
        const set = new Set(arg.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")));
        rows = rows.filter((r) => set.has(String(r[k])));
      } else if (op === "is" && arg === "null") rows = rows.filter((r) => r[k] === null || r[k] === undefined);
    }
    if (order) {
      const [col, asc] = order;
      rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
    return rows;
  }

  private findOcc(oid: unknown): Row | undefined {
    return this.tables.occurrences!.find((o) => o.id === oid);
  }

  private rpc(fn: string, b: Row): { data: unknown } | { error: string } {
    const now = NOW.toISOString();
    switch (fn) {
      case "ensure_occurrences":
        return { data: 0 };
      case "record_done": {
        const o = this.findOcc(b.p_occurrence_id);
        if (!o) return { error: "not_found" };
        const start = new Date(String(b.p_actual_start_at));
        const exec = {
          id: id(100 + this.tables.executions!.length), occurrence_id: o.id, planned_date: o.planned_date,
          actual_start_at: start.toISOString(), actual_end_at: new Date(start.getTime() + Number(b.p_actual_duration_min) * 60000).toISOString(),
          actual_duration_min: b.p_actual_duration_min, executed_date: TODAY, is_late_day: TODAY > String(o.planned_date),
          start_source: b.p_start_source, recorded_at: now, superseded_by: null,
        };
        this.tables.executions!.push(exec);
        Object.assign(o, { status: "done", closed_at: now, next_remind_at: null });
        return { data: exec.id };
      }
      case "postpone": {
        const o = this.findOcc(b.p_occurrence_id);
        if (!o) return { error: "not_found" };
        const remind = new Date(NOW.getTime() + 30 * 60000).toISOString();
        Object.assign(o, { status: "postponed", next_remind_at: remind, postpone_count: Number(o.postpone_count) + 1 });
        return { data: remind };
      }
      case "skip_occurrence": {
        const o = this.findOcc(b.p_occurrence_id);
        if (!o) return { error: "not_found" };
        if (!b.p_reason_code) return { error: "reason_required" };
        Object.assign(o, { status: "skipped", closed_at: now });
        return { data: null };
      }
      case "create_routine": {
        const rid = id(500 + this.tables.routines!.length);
        this.tables.routines!.push({ id: rid, user_id: USER_ID, name: b.p_name, note: b.p_note, archived_at: null, created_at: now });
        this.tables.routine_versions!.push({
          id: id(600 + this.tables.routine_versions!.length), routine_id: rid, version_no: 1, name: b.p_name, note: b.p_note,
          weekdays: b.p_weekdays, start_time: `${b.p_start_time}:00`, duration_min: b.p_duration_min, snooze_min: b.p_snooze_min,
          valid_from: TODAY, valid_to: null, change_reason: null, source: "manual", created_at: now,
        });
        return { data: rid };
      }
      case "edit_routine": {
        const vs = this.tables.routine_versions!.filter((v) => v.routine_id === b.p_routine_id);
        const cur = vs.find((v) => v.valid_to === null);
        if (!cur) return { error: "not_found" };
        cur.valid_to = b.p_valid_from;
        const nv = {
          ...cur, id: id(700 + vs.length), version_no: Number(cur.version_no) + 1, name: b.p_name, note: b.p_note, weekdays: b.p_weekdays,
          start_time: `${b.p_start_time}:00`, duration_min: b.p_duration_min, snooze_min: b.p_snooze_min,
          valid_from: b.p_valid_from, valid_to: null, change_reason: b.p_change_reason, created_at: now,
        };
        this.tables.routine_versions!.push(nv);
        return { data: nv.id };
      }
      case "archive_routine": {
        const r = this.tables.routines!.find((x) => x.id === b.p_routine_id);
        if (!r) return { error: "not_found" };
        r.archived_at = now;
        return { data: 1 };
      }
    }
    return { error: "unknown_rpc" };
  }
}
