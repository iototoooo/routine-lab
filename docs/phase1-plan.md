# Phase 1 実装計画（2026-11-07 承認・ローカル実装済み）

`docs/requirements.md`（変更しない）と `docs/plan.md`（第2版）の Phase 1 を、実装できる粒度に具体化したもの。
Phase 0 の実績（`docs/test-report.md`）を前提にする。**DB への適用・公開は、それぞれ直前に承認を得る。**

## 1. 範囲
| 区分 | 要件 | 内容 |
| --- | --- | --- |
| 認証 | F-001〜003 | Phase 0 で実装済み（OTP・AuthGate・ログアウト）。画面の下タブに組み込む |
| ルーティン | F-101〜103, F-105 | 登録・編集（版の追加）・アーカイブ・変更履歴 |
| 予定 | F-201〜203 | 今日と明日の予定を自動作成（0:00 JST の cron ＋ アプリ起動時・登録/編集時）。重複なし。作成時の版の設定を写す |
| 記録 | F-401〜406, F-408 | 完了（予定時刻／今／タイマー）・延期（5種＋理由）・見送り（理由）・翌日以降の実施・未実施の自動確定 |
| 保険 | F-310 | 今日の画面に、今日の予定と前日の未記録を表示 |
| 対象外 | — | 通知ジョブの作成と送信（Phase 2）、分析（Phase 3）、提案・比較・書き出し（Phase 4）、F-104・F-407（Should） |

**Phase 1 では通知ジョブを作らない。** 今の send-push は `test` 以外の文面を持たないため、`initial` / `snooze` を作ると「未対応」で失敗が記録されてしまう。延期の再通知時刻は `occurrences.next_remind_at` と `occurrence_events.remind_at` に保存しておき、Phase 2 でジョブ作成を足す（その時点の未来の予定にも作る）。

## 2. DB の変更（新しいマイグレーション。適用済みのファイルは変えない）
| ファイル（予定） | 内容 |
| --- | --- |
| `2026111x000000_phase1_schema.sql` | 表・制約・索引・不変性のトリガー。`notification_jobs.occurrence_id` に外部キー。Phase 0 の Advisor 指摘（`notification_deliveries` の外部キーの索引）も追加 |
| `2026111x000100_phase1_rls.sql` | RLS（本人の行の SELECT だけ）、`revoke` / `grant` の明示 |
| `2026111x000200_phase1_rpc.sql` | 書き込み用の関数（すべて `security definer`・`search_path = ''`・冒頭で `auth.uid()` の所有者チェック） |
| `2026111x000300_phase1_cron.sql` | 0:00 JST（`0 15 * * *`）予定の作成、0:05 JST（`5 15 * * *`）未実施の確定 |

### 2.1 表（要件 6.1 をもとに、全表に `user_id`）
| 表 | 主な列・制約 | 後の Phase での使い道 |
| --- | --- | --- |
| `routines` | name（1〜40文字）、note（≤500）、archived_at、created_at | — |
| `routine_versions` | version_no（ルーティン内で連番、一意）、weekdays `smallint[]`（1〜7、1つ以上、重複なし）、start_time（5分単位）、duration_min（5〜480）、snooze_min、valid_from、valid_to（null＝現在、終わりの日は含まない）、change_reason（≤200）、source（`manual` / `suggestion`）、suggestion_id（外部キーは Phase 4 で付ける）。**期間の重なりを `exclude using gist` で禁止** | F-701 の版どうしの比較、提案の承認で新しい版（source = suggestion） |
| `occurrences` | routine_version_id、planned_date（JST）、planned_start_at、planned_duration_min（版から写す）、status（`scheduled` / `notified` / `postponed` / `done` / `skipped` / `missed` / `cancelled`）、next_remind_at、closed_at、postpone_count。**一意：(routine_id, planned_date)** | 達成率（done ÷ done+skipped+missed）、曜日別・時間帯別（planned_start_at から） |
| `executions` | actual_start_at、actual_end_at、actual_duration_min（1〜1440）、executed_date（JST）、planned_date（写し）、**is_late_day は生成列（executed_date > planned_date）**、start_source（`planned` / `now` / `timer` / `manual`）、recorded_at、superseded_by。**現行の実績は予定ごとに1件（部分一意索引）** | 遅延（actual_start_at − planned_start_at）、所要時間の比（R-03）、翌日以降の割合 |
| `occurrence_events` | type（`done` / `postponed` / `skipped` / `missed` / `edited` / `cancelled` / `notified`）、from_status、to_status、remind_at、postpone_option（`10m` / `30m` / `1h` / `today_at` / `tomorrow_same`）、reason_code、reason_text（≤500）、actor（`user` / `system`）、detail（jsonb：編集前後の値など）、created_at。**追記のみ** | 理由の内訳（F-508）、R-04（時間不足）、R-05（延期の常態化） |

- 理由コード：`no_time / tired / forgot / plans / sick / unmotivated / other`（F-408）。SQL の check 制約と `src/lib/domain/reasons.ts` で同じ一覧を持ち、単体テストで一致を確かめる。
- **履歴を上書きしない仕組み**：
  - クライアントには INSERT / UPDATE / DELETE の権限を与えない（書き込みは RPC だけ）。
  - `routine_versions` はトリガーで UPDATE を禁止する（例外は RPC が `valid_to` を null から日付に閉じるときだけ）。DELETE も禁止。
  - `occurrence_events` と `executions` は UPDATE / DELETE を禁止する。例外は `executions.superseded_by` を一度だけ付けるとき。
  - 予定には、作成時の版の ID・開始時刻・所要時間を写す。版を変えても過去の予定は変わらない。

### 2.2 書き込み用の関数（RPC）
| 関数 | 内容 |
| --- | --- |
| `create_routine(name, note, weekdays, start_time, duration_min, snooze_min)` | ルーティン＋版1（valid_from = 今日 JST）を作り、`ensure_occurrences` |
| `edit_routine(routine_id, name, note, weekdays, start_time, duration_min, snooze_min, valid_from, change_reason)` | valid_from は今日以降かつ現行の版の valid_from 以降。現行の版の valid_to を閉じて新しい版を追加。**valid_from 以降の予定のうち、状態が scheduled でイベントがないものだけ**を新しい版に合わせる（曜日から外れたら cancelled）。編集前の値は `edited` イベントの detail に残す。通知済み・記録済みの予定はそのまま |
| `archive_routine(routine_id)` | archived_at を設定。まだ始まっていない未記録の予定（planned_start_at > 今）を cancelled にする。開始時刻を過ぎた今日の予定は、記録または未実施の確定のため残す |
| `ensure_occurrences()` / `ensure_occurrences_all()` | 今日・明日（JST）について、その日に有効な版の曜日なら予定を作る（`on conflict do nothing`）。前者は本人の分（アプリ起動時）、後者は cron 用（service_role / postgres だけ）。どちらも先に `close_missed` 相当を本人の分に適用する（cron が止まっていても正しく確定する） |
| `record_done(occurrence_id, actual_start_at, actual_duration_min, start_source)` | scheduled / notified / postponed のときだけ。execution を追加し、status = done、イベントを追記。実際の開始は予定日の0:00 JST 以降・現在以前 |
| `postpone(occurrence_id, option, remind_at, reason_code, reason_text)` | remind_at は現在より後で、期限（予定日の翌日の終わり）以内。status = postponed、next_remind_at、postpone_count + 1、イベント |
| `skip(occurrence_id, reason_code, reason_text)` | status = skipped、イベント |
| `close_missed()` | planned_date ≤ 今日 − 2 の未確定を missed にし、system のイベントを追記 |

## 3. 画面（静的出力・ID はクエリ文字列）
| 画面 | パス | Phase 1 の内容 |
| --- | --- | --- |
| S-02 今日 | `/` | 起動時に `ensure_occurrences`。今日の予定を時刻順に、状態のバッジつきで表示。前日の未記録の予定。各予定から「完了」（1タップで予定どおり完了）と「記録」へ |
| S-03 記録 | `/record/?o=<ID>` | 完了（開始＝予定時刻／今／タイマー、所要時間の既定は予定所要時間）・延期（10分・30分・1時間・今日の指定時刻・明日の同じ時刻＋理由）・見送り（理由）。**通知から3タップ以内**。Phase 0 のテスト通知（`o=test-…`）の表示も残す |
| S-04 一覧 | `/routines/` | 有効なルーティン（曜日・時刻・所要時間）。アーカイブ済みは折りたたみで表示だけ（復元は F-104 で後回し） |
| S-05 編集 | `/routines/edit/?id=<ID>` | 新規／編集。編集時は適用開始日（既定は今日）と変更理由。保存前に「変更前 → 変更後」を表示 |
| S-06 詳細 | `/routines/detail/?id=<ID>` | 版の履歴（設定・有効期間・理由・きっかけ）、直近の予定と実績 |
| 共通 | — | 下タブ（今日・ルーティン・設定。分析は Phase 3 で追加）。タップ領域 44px 以上 |

## 4. 画面から切り離す処理（`src/lib/`、Vitest で確認）
- `time/jst.ts` に追加：期限（予定日の翌日の終わり）、延期時刻の計算（5種）、5分単位への丸め。
- `domain/`：状態ごとに選べる操作、理由コード、ルーティンの入力チェック（RPC と同じ規則）、版の差分の表示用データ。
- `data/`：supabase-js の呼び出し（RPC・SELECT）をまとめる。画面は直接 SQL の形を知らない。

## 5. テスト
| 種類 | 内容 |
| --- | --- |
| 単体（Vitest） | JST の日付・曜日、14:59 / 15:00 UTC の境界、23:30 開始 60 分（予定日は開始日）、日曜→月曜、月末・年末、延期時刻（「明日の同じ時刻」が期限内か）、翌日実施の判定、状態ごとの操作、入力チェック、理由コードが SQL と一致 |
| DB / RLS | SQL のテストを**1つのトランザクションで実行し、最後に ROLLBACK**（データを残さない）。テスト用ユーザー A・B を `auth.users` に一時的に作り、`set local role authenticated` と JWT の claims で本人になりきって確認：B は A の行を読めない・A の予定を記録できない／版を UPDATE できない／`ensure_occurrences` を2回呼んでも重複しない／編集で過去・記録済みの予定が変わらない／未実施の確定は期限の後だけ／表へ直接 INSERT できない。Phase 0 で後回しにした「他人の端末に届かない」（`push_subscriptions` の RLS）もここで確認 |
| ブラウザ（Playwright） | `out/` を静的に配信し、Supabase への通信は**テスト内の偽の応答**に置き換える（本番のデータ・メールを使わない）。登録 → 今日 → 記録（3タップ以内）、編集で適用開始日と理由を入力、44px の確認。Chromium と WebKit のスマホ表示 |
| 実機（iPhone） | 本番 URL で、登録 → 今日の表示 → 記録 → 詳細の履歴。Phase 1 の公開後に1回 |

## 6. 進め方（★＝直前に承認をいただく外部操作）
1. 純粋関数とその単体テスト → 画面（ローカルで偽の応答を使って確認）
2. マイグレーション4本を作成し、自己レビュー → ★ `db push --dry-run` の結果を見せて `db push` の承認
3. ★ DB テスト（ROLLBACK するトランザクションを本番の routine-lab に対して実行。データは残らない）
4. ローカル（`npm run dev`）で本物の DB を使って動作確認
5. ★ GitHub への push（Cloudflare Pages が自動で本番に公開する）
6. iPhone で確認 → `docs/test-report.md` に記録

## 7. 判断事項（2026-11-07 承認済み）
| # | 論点 | 推奨案 |
| --- | --- | --- |
| 1 | 今日の開始時刻を過ぎてからルーティンを登録・編集したとき、今日の予定を作るか | **作らない**（過ぎた予定がすぐ「未記録」になり、分析に意味のない失敗が混ざるため）。0:00 の cron と翌日以降は通常どおり |
| 2 | アーカイブ時に、開始時刻を過ぎた今日の未記録の予定をどうするか | **残す**（記録できる。記録しなければ未実施になる）。始まっていない予定は cancelled |
| 3 | DB テストを本番の routine-lab で行うこと | 無料枠の2プロジェクトを使い切っているため、**ROLLBACK するトランザクションで実行**（データは残らない）。実行のたびに承認をいただく |
| 4 | 通知ジョブを Phase 1 で作らない | **作らない**（1章の理由）。延期の時刻は保存しておき、Phase 2 で通知につなぐ |

- 承認の内容：1・2・4 は推奨案どおり。3 は「実行前に、テスト用ユーザーの作り方・取り消しの範囲・通知や cron への影響がないことを示し、別途承認を得る」条件つき。

## 8. ローカル実装の結果（2026-11-07）
### 作ったもの
| 区分 | ファイル |
| --- | --- |
| マイグレーション（未適用） | `20261107000000_phase1_schema.sql`（表・制約・履歴の保護・分析用ビュー `occurrence_facts`・Phase 0 の表とのつなぎ）、`…000100_phase1_rls.sql`、`…000200_phase1_rpc.sql`、`…000300_phase1_cron.sql` |
| 画面 | `/`（今日）、`/record/`（記録）、`/routines/`（一覧）、`/routines/edit/`（登録・編集・アーカイブ）、`/routines/detail/`（版の履歴・予定と実績）。下のタブから「分析」を外した（Phase 3 で追加） |
| 純粋関数 | `src/lib/domain/`（状態・理由・延期時刻・完了の入力・ルーティンの入力と差分・版）、`src/lib/time/`（期限・時間帯など） |
| テスト | 単体 `tests/unit/domain.test.ts`、DB `tests/db/*.test.ts`（PGlite）、ブラウザ `tests/e2e/phase1.spec.ts`（Playwright）、本番スモーク `supabase/tests/phase1_smoke.sql` |

### 要件の解釈・計画から補った点
- **完了の「今」**：記録は終わってからすることが多いため「今終わった（開始＝今−所要時間）」とした。ほかに「予定どおりの時刻に始めた」「開始時刻を指定」「タイマー」。開始の決め方は `executions.start_source` に残し、分析で見分けられる。
- **見送りの理由は必須**（F-404 は「理由を記録する」）。延期の理由は任意（F-403 は「任意」）。
- **版に名前とメモも写す**：変更履歴で、その時点の名前を表示できるようにするため。
- **一度も有効にならなかった版**：同じ日に2回編集すると、前の版は `[適用日, 適用日)` の空の期間で残る（消さない）。
- **分析用ビュー `occurrence_facts` を Phase 1 で作成**：予定1回分ごとに、曜日・時間帯・最終結果・遅延（分）・所要時間の比・翌日以降の実施・延期回数・見送り/未実施の理由を1行にまとめる（RLS は呼び出した人の権限で効く）。Phase 3・4 の集計と提案ルール R-01〜R-05 の入力になる。
- **1人あたりのルーティンは50件まで**（誤操作で表が膨らまないように）。
- **記録の期限を過ぎた予定は記録できない**（未実施の後からの修正は F-407・Should で後回し）。
- **今日の画面の「予定どおり完了」ボタン**は、開始時刻を過ぎた予定にだけ出す（未来の開始時刻では記録できないため）。

### テスト結果
| 種類 | 件数 | 結果 |
| --- | --- | --- |
| 単体＋DB（`npm test`） | 112 件（DB：権限と RLS 15、作成・編集・記録・未実施・アーカイブ・分析ビュー 28、TS と SQL の一致 3、本番スモークの手元実行 1） | すべて成功 |
| ブラウザ（`npm run test:e2e`） | 12 場面 × 2 端末（Pixel 7 / iPhone 14）＝ 24 件 | すべて成功 |
| Lint・型チェック・静的出力・ビルド・秘密情報（リポジトリと out/）・Deno | — | すべて成功 |

### テストで見つけて直した問題
- 履歴を守るトリガーが、表ごとに違う列名（`valid_to` / `superseded_by`）を直接読んでいたため、別の表で「列がない」というエラーになっていた（変更は拒否されていたが、理由が正しくなかった）。jsonb で比べる形に直した。

## 9. 本番への反映（2026-11-07 17:52 JST、承認 A）
- 実行：`npx supabase db push --remote=vmlxzeraeimxgkjxivnl --skip-vault --yes`（接続先 routine-lab・production を表示で確認、dry-run で 4 本だけを確認してから実行）。
- 事前：本番に Phase 1 と同名の関数・表がないこと、`occurrence_id` を持つ通知ジョブが 0 件（追加する外部キーが既存行に影響しない）ことを確認。
- 反映後に確かめたこと（読み取りのみ）：
  - 適用済みは 7 本（Phase 0 の 3 本＋Phase 1 の 4 本）。5 表＋ビュー `occurrence_facts`（security_invoker）がある。行は 0 件。
  - 5 表すべて RLS 有効。anon は表・ビュー・連番・関数のどれも使えない。authenticated は SELECT と、7 つの入口の関数だけ。内部の関数（`_xxx`・`ensure_occurrences_all`・`close_missed` など）は使えない。すべての関数が `search_path=""`。
  - 履歴を守るトリガー 4 つが有効。関数 32 個と制約 75 個の定義が、手元でテストしたものと完全に一致（本文の md5 で比較）。
  - cron：既存の毎分の通知（`routine-lab-dispatch-push`）は反映の前後とも成功し続けている。新しい 2 件は `0 15 * * *`（0:00 JST）と `5 15 * * *`（0:05 JST）。cron のタイムゾーンは GMT。
  - Phase 0 の 5 表の行（件数と内容の md5）、端末の登録 2 件（有効）、Vault の 2 件、Function の Secrets 12 件は、反映の前後で変わっていない。
- 取り消し手順：`supabase/rollback/20261107_phase1_down.sql`（実行は承認後のみ。Phase 1 のデータも消える）。`tests/db/rollback.test.ts` で「反映 → 取り消し」が Phase 0 だけの状態と一致することを確認している。

## 10. 本番スモークテスト（2026-11-07 21:45 JST、承認 B）
- 実行：`npx supabase db query --remote=vmlxzeraeimxgkjxivnl -f supabase/tests/phase1_smoke.sql --yes`
- 結果：`SMOKE_OK checks=13 (rolled back)`（13 項目すべて成功。CLI は意図どおりエラー終了）。
- 実行後の確認（読み取りのみ）：Phase 1 の 5 表は 0 行。`auth.users` 1 件・`profiles` 1 件で前後同じ（内容の md5 も同じ）、`smoke-*@example.invalid` は 0 件。Phase 0 の表・Vault・cron・関数・権限のスナップショットは前後で差分なし。pg_net の応答記録は直近 15 分で 0 件、毎分の通知 cron は失敗 0。
