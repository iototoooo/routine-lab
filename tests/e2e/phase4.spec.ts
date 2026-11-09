// Phase 4 の画面（docs/phase4-plan.md 4・5章）：改善提案の一覧 → 確認 → 承認（版が増える）、却下、取り消し、
// 古い提案の承認の拒否、変更前後の比較、データの書き出し。ルールの数値の正しさは tests/unit/suggestions.test.ts、
// DB の規則（古い提案・28 日・権限）は tests/db/phase4-suggestions.test.ts で確かめている。
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { FakeSupabase, IDS } from "./fake-supabase";

let fake: FakeSupabase;
const WEEKDAY: Record<string, number> = { "11-02": 1, "11-03": 2, "11-04": 3, "11-05": 4, "11-06": 5, "11-07": 6, "11-08": 7, "11-09": 1 };
let n = 0;
/** 朝のストレッチ（第1版 7:00・15分）の完了の記録 */
function done(date: string, delay: number, dur: number) {
  n += 1;
  const planned = new Date(`${date}T07:00:00+09:00`);
  return {
    occurrence_id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
    routine_id: IDS.routineStretch, routine_version_id: IDS.v1Stretch, version_no: 1,
    planned_date: date, planned_weekday: WEEKDAY[date.slice(5)], planned_start_at: planned.toISOString(), time_band: "morning",
    planned_duration_min: 15, status: "done", is_final: true, postpone_count: 0,
    actual_start_at: new Date(planned.getTime() + delay * 60000).toISOString(), actual_duration_min: dur,
    executed_date: date, is_late_day: false, start_source: "now", delay_min: delay, closing_reason_code: null,
  };
}

test.beforeEach(async ({ page }) => {
  fake = new FakeSupabase();
  // 直近 4 週（10/13〜11/9）に 6 件：毎回 30 分遅れて始め、25 分かかっている → R-01 と R-03 の 2 種類
  fake.tables.occurrence_facts = ["11-03", "11-04", "11-05", "11-06", "11-07", "11-08"].map((d) => done(`2026-${d}`, 30, 25));
  await fake.install(page);
});

const cardOf = (page: Page, title: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });

test("分析から改善提案を開くと、2 種類の提案が根拠（期間・件数・数値）と変更前後つきで出る。データ不足も示す", async ({ page }) => {
  await page.goto("/analytics/");
  await page.getByRole("link", { name: /改善提案：2 件あります/ }).click();
  await expect(page).toHaveURL(/\/suggestions\/$/);
  await expect(page.getByRole("heading", { name: "今の提案（2 件）" })).toBeVisible();

  const r01 = cardOf(page, "開始の遅れが続いています");
  await expect(r01).toContainText("10/13（火）〜11/9（月）");
  await expect(r01).toContainText("確定した予定 6 件");
  await expect(r01).toContainText("+30分（実測・時刻指定の記録 6 件）");
  await expect(r01.getByRole("row", { name: /開始時刻/ })).toContainText("07:0007:30");
  const r03 = cardOf(page, "所要時間が足りていません");
  await expect(r03.getByRole("row", { name: /所要時間/ })).toContainText("15分25分");
  await expect(r03).toContainText("予定の 1.67 倍、完了 6 件");

  // 夜の読書は記録がないのでデータ不足（無理に提案しない）
  const notes = page.locator("section", { has: page.getByRole("heading", { name: "ルーティンごとの状況" }) });
  await expect(notes.getByRole("listitem").filter({ hasText: "夜の読書" })).toContainText("データ不足今の設定で確定した予定 0 件");
  // 一覧からは承認できない（確認画面へ進むだけ）
  await expect(page.getByRole("button", { name: /承認/ })).toHaveCount(0);
});

test("確認画面で承認すると新しい版ができ（既定は明日から）、履歴に「改善提案」と出る。取り消しは元の設定で新しい版を作る", async ({ page }) => {
  await page.goto("/suggestions/");
  await cardOf(page, "開始の遅れが続いています").getByRole("link", { name: "内容を確認する" }).click();
  await expect(page).toHaveURL(/\/suggestions\/confirm\/\?r=.*&rule=R-01/);
  await expect(page.getByLabel("適用開始日")).toHaveValue("2026-11-11");
  await expect(page.getByLabel(/変更理由/)).toHaveValue("改善提案 R-01：開始の遅れ（中央値 +30分）");
  await expect(page.getByText("適用開始日より前の予定と、通知済み・記録済みの予定は変わりません。実績も書き換えません。")).toBeVisible();
  await page.getByRole("button", { name: "承認して新しい版を作る" }).click();

  await expect(page).toHaveURL(new RegExp(`/routines/detail/\\?id=${IDS.routineStretch}&accepted=1`));
  await expect(page.getByRole("status")).toContainText("提案を承認し、第2版を作りました（11/11（水） から）");
  const call = fake.lastCall("accept_suggestion")!;
  expect(call).toMatchObject({
    p_routine_id: IDS.routineStretch, p_rule_id: "R-01", p_base_version_id: IDS.v1Stretch, p_valid_from: "2026-11-11",
    p_proposed: { weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: "07:30", duration_min: 15 },
    p_evidence: { rule: "R-01", medianDelay: 30, samples: 6, from: "2026-10-13", to: "2026-11-09", finals: 6 },
  });
  const history = page.locator("section", { has: page.getByRole("heading", { name: "設定の履歴" }) });
  await expect(history.getByRole("listitem").first()).toContainText("きっかけ：改善提案（R-01「開始の遅れが続いています」）");

  // 取り消し：提案の前の設定（7:00）を入れた編集画面 → 確認 → 保存（ふだんの編集＝新しい版）
  await history.getByRole("link", { name: "この変更を取り消す（元の設定に戻す）" }).click();
  await expect(page.getByRole("note")).toContainText("第1版の設定に戻す内容を入れました");
  await expect(page.getByLabel(/変更理由/)).toHaveValue("改善提案 R-01 の取り消し");
  await expect(page.getByLabel("適用開始日")).toHaveValue("2026-11-11");
  await page.getByRole("button", { name: "変更内容を確認" }).click();
  await expect(page.getByRole("row", { name: /開始時刻/ })).toContainText("07:3007:00");
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page).toHaveURL(/\/routines\/detail\//);
  expect(fake.lastCall("edit_routine")).toMatchObject({ p_start_time: "07:00", p_valid_from: "2026-11-11", p_change_reason: "改善提案 R-01 の取り消し" });
  expect(fake.tables.routine_versions!.filter((v) => v.routine_id === IDS.routineStretch)).toHaveLength(3);
});

test("却下すると判断だけを記録し、一覧から消えて判断の記録に残る（版は増えない）", async ({ page }) => {
  await page.goto("/suggestions/");
  const r03 = cardOf(page, "所要時間が足りていません");
  await r03.getByRole("button", { name: "却下する" }).click();
  await expect(r03).toContainText("設定は変わりません。同じ種類の提案は 28 日間出なくなります。");
  await r03.getByRole("button", { name: "却下する" }).click();
  await expect(page.getByRole("heading", { name: "今の提案（1 件）" })).toBeVisible();
  expect(fake.lastCall("reject_suggestion")).toMatchObject({ p_rule_id: "R-03", p_base_version_id: IDS.v1Stretch });
  expect(fake.tables.routine_versions!.filter((v) => v.routine_id === IDS.routineStretch)).toHaveLength(1);
  const log = page.locator("section", { has: page.getByRole("heading", { name: "判断の記録" }) });
  await expect(log).toContainText("却下・11/10（火）・朝のストレッチ");
  await expect(log).toContainText("R-03「所要時間が足りていません」：所要時間 15分 → 25分");
  await expect(page.getByRole("listitem").filter({ hasText: "朝のストレッチ" }).filter({ hasText: "判断済み" })).toContainText("R-03「所要時間が足りていません」は判断済みのため 12/8（火） まで出しません。");
});

test("確認画面を開いた後に設定が変わっていたら、承認を受け付けず理由を示す（古い提案）", async ({ page }) => {
  await page.goto(`/suggestions/confirm/?r=${IDS.routineStretch}&rule=R-01`);
  await expect(page.getByRole("button", { name: "承認して新しい版を作る" })).toBeVisible();
  // 別の端末で手動編集された想定
  const cur = fake.tables.routine_versions!.find((v) => v.id === IDS.v1Stretch)!;
  cur.valid_to = "2026-11-10";
  fake.tables.routine_versions!.push({ ...cur, id: "00000000-0000-4000-8000-000000000099", version_no: 2, valid_from: "2026-11-10", valid_to: null });
  await page.getByRole("button", { name: "承認して新しい版を作る" }).click();
  await expect(page.getByText("この提案のもとにした設定が変わっています。提案の一覧を開き直してください。")).toBeVisible();
  await expect(page).toHaveURL(/\/suggestions\/confirm\//);
  // 開き直すと、新しい版には記録がないので提案は出ない
  await page.reload();
  await expect(page.getByText("この提案は今は出ていません。")).toBeVisible();
});

test("変更前後の比較：同じ日数・件数・注意を示し、版が1つならデータ不足", async ({ page }) => {
  const v1 = fake.tables.routine_versions!.find((v) => v.id === IDS.v1Stretch)!;
  v1.valid_to = "2026-11-06";
  const V2 = "00000000-0000-4000-8000-000000000013";
  fake.tables.routine_versions!.push({ ...v1, id: V2, version_no: 2, start_time: "07:30:00", valid_from: "2026-11-06", valid_to: null, source: "suggestion" });
  for (const f of fake.tables.occurrence_facts!) if (String(f.planned_date) >= "2026-11-06") Object.assign(f, { routine_version_id: V2, version_no: 2, delay_min: 0 });

  await page.goto(`/routines/detail/?id=${IDS.routineStretch}`);
  await page.getByRole("link", { name: "版を選んで比べる" }).click();
  await expect(page).toHaveURL(/\/routines\/compare\/\?id=/);
  await expect(page.getByLabel("変更前の版")).toHaveValue(IDS.v1Stretch);
  await expect(page.getByLabel("変更後の版")).toHaveValue(V2);
  await expect(page.getByText("設定の違い：開始時刻 07:00 → 07:30")).toBeVisible();
  await expect(page.getByText(/同じ 5 日間で比較：変更前 11\/1（日）〜11\/5（木）、変更後 11\/6（金）〜11\/10（火）/)).toBeVisible();
  const table = page.getByRole("table", { name: "変更前と変更後の比較" });
  await expect(table.getByRole("row", { name: /^達成率/ })).toContainText("100%（3/3件）参考値100%（3/3件）参考値");
  await expect(table.getByRole("row", { name: /^遅れ（中央値）/ })).toContainText("+30分（3件）参考値0分（3件）参考値");
  await expect(page.getByText("注意：比べられる期間が 5 日だけです（目安は 28 日）。")).toBeVisible();
  await expect(page.getByText("注意：変更前の確定した予定が 3 件だけです（5件未満は参考値）。")).toBeVisible();

  // 順番を逆に選ぶと比べない
  await page.getByLabel("変更前の版").selectOption(V2);
  await expect(page.getByText("「変更前の版」には「変更後の版」より古い版を選んでください。")).toBeVisible();

  await page.goto(`/routines/compare/?id=${IDS.routineReading}`);
  await expect(page.getByText("比べられる版が 2 つ以上ありません。")).toBeVisible();
});

test("データの書き出し：CSV（予定1回＝1行、BOM 付き）と JSON（本人の記録だけ・端末の情報なし）", async ({ page }) => {
  // 共有シートがない端末（ダウンロードで保存する）として確かめる
  await page.addInitScript(() => Object.defineProperty(navigator, "share", { value: undefined, configurable: true }));
  await page.goto("/settings/");
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "予定と実績を書き出す（CSV）" }).click()]);
  expect(csv.suggestedFilename()).toBe("routine-lab-20261110.csv");
  const text = readFileSync((await csv.path())!, "utf8");
  expect(text.startsWith("﻿予定日,曜日,ルーティン,")).toBe(true);
  expect(text.trim().split("\r\n")).toHaveLength(7);
  expect(text).toContain("2026-11-03,火,朝のストレッチ,1,2026-11-03 07:00,15,完了,0,2026-11-03 07:30,25");
  await expect(page.getByRole("status")).toContainText("ファイルを書き出しました。");

  const [json] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "すべての記録を書き出す（JSON）" }).click()]);
  const data = JSON.parse(readFileSync((await json.path())!, "utf8"));
  expect(Object.keys(data.tables)).toEqual(["profiles", "routines", "routine_versions", "occurrences", "executions", "occurrence_events", "suggestions", "notification_jobs"]);
  expect(data.tables.routines).toHaveLength(2);
  expect(JSON.stringify(data.tables)).not.toMatch(/endpoint|p256dh|access_token|refresh_token/);
  // 書き出しは読み取りだけ（RPC を呼ばない）
  expect(fake.calls.filter((c) => c.fn !== "ensure_occurrences")).toEqual([]);
});

test("テスト用（分析に含めない）のルーティンには提案を出さない", async ({ page }) => {
  fake.tables.routines!.find((r) => r.id === IDS.routineStretch)!.exclude_from_analytics = true;
  await page.goto("/suggestions/");
  await expect(page.getByRole("heading", { name: "今の提案（0 件）" })).toBeVisible();
  await expect(page.getByText("今は提案はありません。")).toBeVisible();
  await expect(page.locator("section", { has: page.getByRole("heading", { name: "ルーティンごとの状況" }) })).not.toContainText("朝のストレッチ");
});
