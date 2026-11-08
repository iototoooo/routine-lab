// Phase 2 の画面（docs/phase2-plan.md 5章）：今日の画面の通知の状態と、記録画面の通知の履歴。
// 送信そのもの（DB・send-push）は tests/db と tests/unit で確かめている。
import { expect, test } from "@playwright/test";
import { FakeSupabase, IDS, NOW } from "./fake-supabase";

let fake: FakeSupabase;
test.beforeEach(async ({ page }) => {
  fake = new FakeSupabase();
  await fake.install(page);
});

test("今日の画面：送信済み・送信予定の通知を予定ごとに表示する", async ({ page }) => {
  await page.goto("/");
  const today = page.locator("section", { has: page.getByRole("heading", { name: /^今日/ }) });
  await expect(today.getByRole("listitem").nth(0)).toContainText("通知 07:00 に送信済み");
  await expect(today.getByRole("listitem").nth(1)).toContainText("通知 21:00 に送信予定");
});

test("延期中の再通知の予定と、送れなかった通知の案内を表示する", async ({ page }) => {
  const occ = fake.tables.occurrences!.find((o) => o.id === IDS.occTonight)!;
  Object.assign(occ, { status: "postponed", next_remind_at: new Date(NOW.getTime() + 10 * 60000).toISOString(), postpone_count: 1 });
  fake.tables.notification_jobs!.push({ occurrence_id: IDS.occTonight, kind: "snooze", fire_at: new Date(NOW.getTime() + 10 * 60000).toISOString(), status: "pending", sent_at: null });
  Object.assign(fake.tables.notification_jobs![0]!, { status: "failed", sent_at: null });
  await page.goto("/");
  const today = page.locator("section", { has: page.getByRole("heading", { name: /^今日/ }) });
  await expect(today.getByRole("listitem").nth(1)).toContainText("再通知 07:40 に送信予定");
  await expect(today.getByRole("listitem").nth(0)).toContainText("通知（07:00）を送れませんでした");
});

test("通知から開いた記録画面：通知の履歴（予定時刻・送信した端末数）を表示し、そのまま完了を記録できる", async ({ page }) => {
  Object.assign(fake.tables.occurrences!.find((o) => o.id === IDS.occToday)!, { status: "notified" });
  fake.tables.occurrence_events!.push({
    id: 1, occurrence_id: IDS.occToday, type: "notified", from_status: "scheduled", to_status: "notified", remind_at: null,
    postpone_option: null, reason_code: null, reason_text: null, actor: "system",
    detail: { kind: "initial", accepted_devices: 2 }, created_at: new Date("2026-11-10T07:00:05+09:00").toISOString(),
  });
  await page.goto(`/record/?o=${IDS.occToday}`);
  await expect(page.getByText(/通知（予定時刻・2台へ送信）/)).toBeVisible();
  await page.getByRole("button", { name: "完了を記録" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(fake.lastCall("record_done")).toMatchObject({ p_occurrence_id: IDS.occToday, p_start_source: "planned" });
});
