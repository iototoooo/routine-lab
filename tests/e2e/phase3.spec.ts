// Phase 3 の画面（docs/phase3-plan.md 5章）：分析タブ、絞り込み、参考値・データなし・未確定の表示、
// テスト用ルーティンの除外、ルーティン詳細の版ごとの集計と切り替え。数値の正しさは tests/unit/analytics.test.ts で確かめている。
import { expect, test, type Page } from "@playwright/test";
import { FakeSupabase, IDS, USER_ID } from "./fake-supabase";

let fake: FakeSupabase;
const TEST_ROUTINE = "00000000-0000-4000-8000-000000000003";
const V2_STRETCH = "00000000-0000-4000-8000-000000000013";
const WEEKDAY: Record<string, number> = { "11-01": 7, "11-02": 1, "11-03": 2, "11-04": 3, "11-05": 4, "11-06": 5, "11-07": 6, "11-08": 7, "11-09": 1, "11-10": 2 };

let n = 0;
type F = { routine: string; version: string; date: string; time: string; status: string; delay?: number; source?: string; postpones?: number; reason?: string };
function fact(f: F) {
  n += 1;
  const planned = new Date(`${f.date}T${f.time}:00+09:00`);
  const done = f.status === "done";
  const hour = Number(f.time.slice(0, 2));
  const band = hour >= 4 && hour < 7 ? "early" : hour < 10 && hour >= 7 ? "morning" : hour >= 18 && hour < 22 ? "evening" : "night";
  return {
    occurrence_id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
    routine_id: f.routine, routine_version_id: f.version, version_no: f.version === V2_STRETCH ? 2 : 1,
    planned_date: f.date, planned_weekday: WEEKDAY[f.date.slice(5)], planned_start_at: planned.toISOString(), time_band: band,
    planned_duration_min: 15, status: f.status, is_final: ["done", "skipped", "missed"].includes(f.status), postpone_count: f.postpones ?? 0,
    actual_start_at: done ? new Date(planned.getTime() + (f.delay ?? 0) * 60000).toISOString() : null,
    actual_duration_min: done ? 15 : null, executed_date: done ? f.date : null, is_late_day: done ? false : null,
    start_source: done ? (f.source ?? "now") : null, delay_min: done ? (f.delay ?? 0) : null, closing_reason_code: f.reason ?? null,
  };
}

/**
 * 朝のストレッチ（07:00）：11/1〜11/9 は 完了7・見送り1・未実施1、11/10 は未確定。11/6 から第2版。
 * 夜の読書（21:00）：11/9 完了（実測10分遅れ）。
 * テスト（分析に含めない）：11/9・11/10 見送り。
 * → 4週：80%（8/10件）、テストも含めると 67%（8/12件）、直近7日：71%（5/7件）
 */
function seed(f: FakeSupabase) {
  const s = (date: string, status: string, extra: Partial<F> = {}) =>
    fact({ routine: IDS.routineStretch, version: date >= "2026-11-06" ? V2_STRETCH : IDS.v1Stretch, date, time: "07:00", status, ...extra });
  f.tables.occurrence_facts = [
    s("2026-11-01", "done", { delay: 0, source: "planned" }),
    s("2026-11-02", "done", { delay: 5 }),
    s("2026-11-03", "done", { delay: 25, postpones: 1 }),
    s("2026-11-04", "skipped", { reason: "tired" }),
    s("2026-11-05", "missed"),
    s("2026-11-06", "done", { delay: 0, source: "planned" }),
    s("2026-11-07", "done", { delay: 15, source: "timer" }),
    s("2026-11-08", "done", { delay: 0, source: "planned" }),
    s("2026-11-09", "done", { delay: 40, source: "manual" }),
    s("2026-11-10", "scheduled"),
    fact({ routine: IDS.routineReading, version: IDS.v1Reading, date: "2026-11-09", time: "21:00", status: "done", delay: 10 }),
    fact({ routine: TEST_ROUTINE, version: "v-test", date: "2026-11-09", time: "23:50", status: "skipped", reason: "other" }),
    fact({ routine: TEST_ROUTINE, version: "v-test", date: "2026-11-10", time: "23:50", status: "skipped", reason: "other" }),
  ];
  const third = f.tables.occurrence_facts[2]!;
  f.tables.occurrence_reason_facts = [
    { event_id: 1, occurrence_id: third.occurrence_id, routine_id: IDS.routineStretch, planned_date: "2026-11-03", type: "postponed", reason_code: "no_time", postpone_option: "10m" },
    { event_id: 2, occurrence_id: f.tables.occurrence_facts[3]!.occurrence_id, routine_id: IDS.routineStretch, planned_date: "2026-11-04", type: "skipped", reason_code: "tired", postpone_option: null },
  ];
  f.tables.routines!.push({ id: TEST_ROUTINE, user_id: USER_ID, name: "テスト", note: null, archived_at: null, created_at: "2026-11-02T00:00:00Z", exclude_from_analytics: true });
  // 朝のストレッチは 11/6 から第2版（7:15 開始）
  const v1 = f.tables.routine_versions!.find((v) => v.id === IDS.v1Stretch)!;
  v1.valid_to = "2026-11-06";
  f.tables.routine_versions!.push({ ...v1, id: V2_STRETCH, version_no: 2, start_time: "07:15:00", valid_from: "2026-11-06", valid_to: null, change_reason: "朝が慌ただしい" });
}

test.beforeEach(async ({ page }) => {
  fake = new FakeSupabase();
  seed(fake);
  await fake.install(page);
});

const summary = (page: Page) => page.locator("section", { has: page.getByRole("heading", { name: "まとめ" }) });

test("分析タブから開け、確定した予定だけで達成率を出す（未確定・テスト用は別に示す）", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "分析" }).click();
  await expect(page).toHaveURL(/\/analytics\/$/);
  const s = summary(page);
  await expect(s).toContainText("80%（8/10件）");
  await expect(s).toContainText("完了 8・見送り 1・未実施 1");
  await expect(s).toContainText("未確定（達成率に入れない）1 件");
  await expect(s).toContainText("テスト用のルーティン 1 件を除いています");
  // 遅れは「予定どおり」の入力（0分）と実測を分けて数える
  await expect(page.getByText("「予定どおり」で記録 3 件（入力上の0分）・実測・時刻指定 5 件（うち0分 0 件）")).toBeVisible();
});

test("期間とルーティンの絞り込み：表示が変わり、5件未満は参考値、テスト用は「含める」で入る", async ({ page }) => {
  await page.goto("/analytics/");
  await page.getByRole("button", { name: "直近7日" }).click();
  await expect(page).toHaveURL(/p=7d/);
  await expect(summary(page)).toContainText("71%（5/7件）");

  await page.getByRole("button", { name: "4週" }).click();
  // チェックの状態はクエリ文字列から決まる（URL が変わってから反映される）
  await page.getByLabel("テスト用のルーティンも含める").click();
  await expect(page.getByLabel("テスト用のルーティンも含める")).toBeChecked();
  await expect(page).toHaveURL(/test=1/);
  await expect(summary(page)).toContainText("67%（8/12件）");

  await page.getByRole("combobox", { name: /^ルーティン/ }).selectOption({ label: "夜の読書" });
  await expect(page).toHaveURL(new RegExp(`r=${IDS.routineReading}`));
  await expect(summary(page)).toContainText("100%（1/1件）");
  await expect(summary(page).getByText("参考値").first()).toBeVisible();
  // 曜日別の表：予定のない曜日は「データなし」（0% にしない）
  const weekday = page.locator("section", { has: page.getByRole("heading", { name: "曜日別" }) });
  await weekday.getByText("表で見る").click();
  await expect(weekday.getByRole("row", { name: /^日曜日/ })).toContainText("データなし");
  await expect(weekday.getByRole("row", { name: /^月曜日/ })).toContainText("100%（1/1件）");
});

test("「実測・時刻指定だけ」に切り替えると、「予定どおり」の記録を除いて遅れを計算する", async ({ page }) => {
  await page.goto("/analytics/?r=" + IDS.routineStretch);
  const delay = page.locator("section", { has: page.getByRole("heading", { name: /^開始の遅れ/ }) });
  await expect(delay).toContainText("+5分（7件）"); // [0,0,0,5,15,25,40] の中央値
  await page.getByRole("button", { name: "実測・時刻指定だけ" }).click();
  await expect(page).toHaveURL(/src=measured/);
  await expect(delay).toContainText("+20分（4件）"); // [5,15,25,40] の中央値
  await expect(delay).toContainText("「予定どおり」で記録 0 件");
});

test("ルーティン詳細：版ごとの集計と、同じ日数での変更前後の比較（期間・件数・注意）。テスト用の切り替え", async ({ page }) => {
  await page.goto(`/routines/detail/?id=${IDS.routineStretch}`);
  const table = page.getByRole("table", { name: "版ごとの集計" });
  await expect(table.getByRole("row", { name: /第2版/ })).toContainText("100%（4/4件）");
  await expect(table.getByRole("row", { name: /第1版/ })).toContainText("60%（3/5件）");
  await expect(page.getByText("第1版と第2版（同じ 5 日間で比較）")).toBeVisible();
  await expect(page.getByText("変更前：第1版 11/1（日）〜11/5（木）")).toBeVisible();
  await expect(page.getByText("比べられる期間が 5 日だけです（目安は 28 日）。")).toBeVisible();
  await expect(page.getByText("変更後の確定した予定が 4 件だけです（5件未満は参考値）。")).toBeVisible();

  await page.getByRole("button", { name: "分析に含めない（テスト用にする）" }).click();
  await expect(page.getByText("分析での扱い：含めない（テスト用）")).toBeVisible();
  expect(fake.lastCall("set_routine_analytics")).toEqual({ p_routine_id: IDS.routineStretch, p_exclude: true });
  await page.getByRole("link", { name: "このルーティンを分析で見る" }).click();
  await expect(page).toHaveURL(new RegExp(`/analytics/\\?r=${IDS.routineStretch}&p=12w`));
});

test("スマートフォンの幅で横にはみ出さず、データがなければ「データなし」", async ({ page }) => {
  fake.tables.occurrence_facts = [];
  fake.tables.occurrence_reason_facts = [];
  await page.goto("/analytics/");
  await expect(summary(page)).toContainText("達成率（完了 ÷ 確定した予定）データなし");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
