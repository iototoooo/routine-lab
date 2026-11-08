// Phase 1 の画面の流れ（docs/phase1-plan.md 5章）。スマホの表示（Pixel 7 / iPhone 14）で確認する。
import { expect, test, type Page } from "@playwright/test";
import { FakeSupabase, IDS, NOW, TODAY } from "./fake-supabase";

let fake: FakeSupabase;
test.beforeEach(async ({ page }) => {
  fake = new FakeSupabase();
  await fake.install(page);
});

/** 見えている操作部品の高さがすべて 44px 以上か（NF-01）。表の中の文字リンクは除く */
async function expectTapTargets(page: Page) {
  const small = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>("button, a, select, textarea, input:not([type=radio]):not([type=checkbox]), summary"),
    );
    return els
      .filter((el) => el.offsetParent !== null && !el.closest("table"))
      .map((el) => ({ text: (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 20), h: el.getBoundingClientRect().height }))
      .filter((x) => x.h < 44);
  });
  expect(small).toEqual([]);
}

test("ログインしていなければログイン画面へ移動する", async ({ page }) => {
  const f = new FakeSupabase();
  const p2 = await page.context().newPage();
  await f.install(p2, { loggedIn: false });
  await p2.goto("/routines/");
  await expect(p2).toHaveURL(/\/login\/\?next=/);
});

test("今日の画面：今日の予定（時刻順）・昨日の未記録・明日を表示し、予定どおり完了を1タップで記録", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /今日 11\/10（火）/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /昨日の未記録/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /明日 11\/11（水）/ })).toBeVisible();
  const today = page.locator("section", { has: page.getByRole("heading", { name: /^今日/ }) });
  await expect(today.getByRole("listitem")).toHaveCount(2);
  await expect(today.getByRole("listitem").nth(0)).toContainText("07:00");
  await expect(today.getByRole("listitem").nth(1)).toContainText("21:00");
  // 21:00 はまだ始まっていないので「予定どおり完了」は出ない
  await expect(today.getByRole("listitem").nth(1).getByRole("button", { name: "予定どおり完了" })).toHaveCount(0);
  await expectTapTargets(page);

  await today.getByRole("listitem").nth(0).getByRole("button", { name: "予定どおり完了" }).click();
  await expect(today.getByRole("listitem").nth(0)).toContainText("完了");
  expect(fake.lastCall("record_done")).toEqual({
    p_occurrence_id: IDS.occToday,
    p_actual_start_at: new Date(`${TODAY}T07:00:00+09:00`).toISOString(),
    p_actual_duration_min: 15,
    p_start_source: "planned",
  });
  expect(fake.calls[0]!.fn).toBe("ensure_occurrences");
});

test("通知から開いた記録画面：既定のまま1タップで完了を記録して今日の画面へ（3タップ以内）", async ({ page }) => {
  await page.goto(`/record/?o=${IDS.occToday}`);
  await expect(page.getByText("朝のストレッチ")).toBeVisible();
  await expect(page.getByRole("radio", { name: /予定どおりの時刻に始めた/ })).toBeChecked();
  await expect(page.getByText(/記録する内容：11\/10（火） 07:00 開始・15分（予定どおり）/)).toBeVisible();
  await expectTapTargets(page);
  await page.getByRole("button", { name: "完了を記録" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(fake.lastCall("record_done")).toMatchObject({ p_occurrence_id: IDS.occToday, p_start_source: "planned", p_actual_duration_min: 15 });
});

test("記録画面：「今終わった」と所要時間で、開始＝今−所要時間を送る", async ({ page }) => {
  await page.goto(`/record/?o=${IDS.occToday}`);
  await page.getByRole("radio", { name: /今終わった/ }).check();
  await page.getByLabel("実際の所要時間（分）").fill("20");
  await expect(page.getByText(/07:10 開始・20分（10分遅れ）/)).toBeVisible();
  await page.getByRole("button", { name: "完了を記録" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(fake.lastCall("record_done")).toMatchObject({
    p_actual_start_at: new Date(NOW.getTime() - 20 * 60000).toISOString(),
    p_actual_duration_min: 20,
    p_start_source: "now",
  });
});

test("延期：選択肢と理由を送る（予定時刻は変えない）", async ({ page }) => {
  await page.goto(`/record/?o=${IDS.occToday}`);
  await page.getByRole("tab", { name: "延期" }).click();
  await page.getByRole("button", { name: "30分後" }).click();
  await expect(page.getByText(/再通知：11\/10（火） 08:00（予定時刻は 07:00 のまま記録します）/)).toBeVisible();
  await page.getByRole("button", { name: "疲れていた" }).click();
  await page.getByLabel("ひとこと（任意）").fill("寝不足");
  await expectTapTargets(page);
  await page.getByRole("button", { name: "延期する" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(fake.lastCall("postpone")).toEqual({
    p_occurrence_id: IDS.occToday,
    p_option: "30m",
    p_remind_at: null,
    p_reason_code: "tired",
    p_reason_text: "寝不足",
  });
});

test("見送り：理由を選ぶまで送れない", async ({ page }) => {
  await page.goto(`/record/?o=${IDS.occYesterday}`);
  await page.getByRole("tab", { name: "見送り" }).click();
  const submit = page.getByRole("button", { name: "今回は見送る" });
  await expect(submit).toBeDisabled();
  await page.getByRole("button", { name: "予定が入った" }).click();
  await submit.click();
  await expect(page).toHaveURL(/\/$/);
  expect(fake.lastCall("skip_occurrence")).toEqual({ p_occurrence_id: IDS.occYesterday, p_reason_code: "plans", p_reason_text: null });
});

test("Phase 0 のテスト通知から開いたときは、案内だけを表示する", async ({ page }) => {
  await page.goto("/record/?o=test-abc");
  await expect(page.getByText(/テスト通知から開きました/)).toBeVisible();
});

test("ルーティンの登録：曜日・開始時刻（5分単位）・所要時間を送る", async ({ page }) => {
  await page.goto("/routines/");
  await page.getByRole("link", { name: "＋ 新しいルーティン" }).click();
  await expect(page.getByRole("heading", { name: "新しいルーティン" })).toBeVisible();
  await expectTapTargets(page);
  // 名前なしでは送らない
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByText("名前を入力してください")).toBeVisible();
  expect(fake.lastCall("create_routine")).toBeUndefined();

  await page.getByPlaceholder("例：朝のストレッチ").fill("  英単語  ");
  await page.getByRole("button", { name: "金曜日" }).click(); // 平日の既定から金曜を外す
  await page.getByRole("button", { name: "日曜日" }).click();
  await page.getByLabel("時", { exact: true }).selectOption("06");
  await page.getByLabel("分", { exact: true }).selectOption("45");
  await page.getByLabel(/予定の所要時間/).fill("20");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page).toHaveURL(/\/routines\/detail\/\?id=/);
  expect(fake.lastCall("create_routine")).toEqual({
    p_name: "英単語",
    p_note: null,
    p_weekdays: [1, 2, 3, 4, 7],
    p_start_time: "06:45",
    p_duration_min: 20,
    p_snooze_min: 10,
  });
});

test("ルーティンの編集：変更前と変更後を確認してから、適用開始日と理由つきで新しい版を保存する", async ({ page }) => {
  await page.goto(`/routines/edit/?id=${IDS.routineStretch}`);
  await expect(page.getByRole("heading", { name: "ルーティンを編集" })).toBeVisible();
  await page.getByLabel("分", { exact: true }).selectOption("30");
  await page.getByLabel(/変更理由/).fill("7時は慌ただしいため");
  await expectTapTargets(page);
  await page.getByRole("button", { name: "変更内容を確認" }).click();
  const row = page.getByRole("row", { name: /開始時刻/ });
  await expect(row).toContainText("07:00");
  await expect(row).toContainText("07:30");
  await expect(page.getByText(/適用開始日：11\/10（火）/)).toBeVisible();
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page).toHaveURL(/\/routines\/detail\/\?id=/);
  expect(fake.lastCall("edit_routine")).toMatchObject({
    p_routine_id: IDS.routineStretch,
    p_start_time: "07:30",
    p_valid_from: TODAY,
    p_change_reason: "7時は慌ただしいため",
  });
  // 詳細画面の履歴に、両方の版と理由が出る
  // 「版ごとの集計」（Phase 3）にも版の番号が出るので、設定の履歴の中で確かめる
  const history = page.locator("section", { has: page.getByRole("heading", { name: "設定の履歴" }) });
  await expect(history.getByText("第2版")).toBeVisible();
  await expect(history.getByText("第1版")).toBeVisible();
  await expect(page.getByText(/変更理由：7時は慌ただしいため・きっかけ：手動/)).toBeVisible();
});

test("変更がなければ確認画面に進まない", async ({ page }) => {
  await page.goto(`/routines/edit/?id=${IDS.routineStretch}`);
  await page.getByRole("button", { name: "変更内容を確認" }).click();
  await expect(page.getByText("変更された項目がありません。")).toBeVisible();
});

test("アーカイブ：確認してから実行し、一覧のアーカイブ済みに移る", async ({ page }) => {
  await page.goto(`/routines/edit/?id=${IDS.routineReading}`);
  await page.getByRole("button", { name: "このルーティンをアーカイブ" }).click();
  await expect(page.getByText(/過去の予定・実績・設定の履歴は残ります/)).toBeVisible();
  await page.getByRole("button", { name: "アーカイブする" }).click();
  await expect(page).toHaveURL(/\/routines\/$/);
  expect(fake.lastCall("archive_routine")).toEqual({ p_routine_id: IDS.routineReading });
  await expect(page.getByText(/アーカイブ済み（1）/)).toBeVisible();
});

test("ルーティン詳細：予定と実績を並べて表示する", async ({ page }) => {
  fake.tables.executions!.push({
    id: "00000000-0000-4000-8000-000000000999", occurrence_id: IDS.occYesterday, planned_date: "2026-11-09",
    actual_start_at: new Date("2026-11-09T07:12:00+09:00").toISOString(), actual_end_at: new Date("2026-11-09T07:32:00+09:00").toISOString(),
    actual_duration_min: 20, executed_date: "2026-11-09", is_late_day: false, start_source: "manual", recorded_at: NOW.toISOString(), superseded_by: null,
  });
  Object.assign(fake.tables.occurrences!.find((o) => o.id === IDS.occYesterday)!, { status: "done", closed_at: NOW.toISOString() });
  await page.goto(`/routines/detail/?id=${IDS.routineStretch}`);
  const row = page.getByRole("row", { name: /11\/9（月）/ });
  await expect(row).toContainText("07:00・15分");
  await expect(row).toContainText("07:12・20分");
  await expect(row).toContainText("12分遅れ");
  await expectTapTargets(page);
});
