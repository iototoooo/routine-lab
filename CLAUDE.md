@AGENTS.md

# Routine Lab — 開発ルール

曜日ごとのルーティンの予定と実績を記録し、PDCA で改善する PWA。
要件は `docs/requirements.md`（**無断で変更しない**）、承認済みの実装計画は `docs/plan.md`。

## 原則（要件 2章）
- **履歴を上書きしない**：ルーティンの設定は版（`routine_versions`）として追加し、作成後は変更しない。予定には作成時の設定を写す。実績の修正は新しい行＋`superseded_by`。
- **3種類の時刻を別の列で持つ**：予定時刻（`planned_start_at`）／通知時刻（`notification_jobs.fire_at`）／実行時刻（`executions.actual_*`）。
- **失敗も記録する**：未実施・見送り・延期・遅延を削除しない。
- **提案は承認制**：改善提案はユーザーが承認したときだけ新しい版にする。却下も記録する。
- **日本時間基準**：日付・曜日は Asia/Tokyo（UTC+9 固定）で判定し、時刻は `timestamptz`（UTC）で保存する。日付の計算は `src/lib/time/jst.ts` を使う。cron は UTC で書く（0:00 JST = `0 15 * * *`）。
- **アクセス制御は DB（RLS）で守る**：画面のチェックは補助。全表で RLS を有効にし、書き込みは原則 RPC（`security definer` ＋ `set search_path = ''` ＋ 所有者チェック）経由。
- **無料枠のみ**：有料の API・プランは使わない。
- **静的出力のみ**：下の「静的出力で使えないもの」を守る。

## コマンド
| 目的 | コマンド |
| --- | --- |
| 開発サーバー | `npm run dev` |
| ビルド（前後に check-static / check-out が自動で走る） | `npm run build` |
| 単体＋DB テスト（全部） | `npm test`（DB / RLS テストは PGlite で手元だけで動く。本番には接続しない） |
| DB / RLS テストだけ | `npx vitest run tests/db` |
| ブラウザテスト | `npm run test:e2e`（偽の接続先でビルド → out/ を配信 → Playwright。初回は `npx playwright install chromium webkit`。ここで作る out/ はテスト専用） |
| 単体テスト（1ファイル） | `npx vitest run tests/unit/jst.test.ts` |
| 単体テスト（名前で絞る） | `npx vitest run -t "isoWeekday"` |
| Lint / 型チェック | `npm run lint` / `npm run typecheck` |
| 静的出力の禁止機能チェック | `npm run check:static` |
| 秘密情報の混入チェック | `npm run check:secrets`（`node scripts/check-secrets.mjs out` で out/ も） |
| まとめて確認 | `npm run check` |
| アイコンの再生成 | `npm run gen:icons` |
| Edge Function の型チェック（Deno） | `npm run check:deno`（`npx` で deno 2.9.6 を一時取得） |
| Edge Function の拒否確認（通知は送らない） | `npm run smoke:functions -- https://vmlxzeraeimxgkjxivnl.supabase.co/functions/v1 <許可オリジン>` |
| 予約通知の経路（CRON_SECRET・Vault）の状態確認／設定／停止 | `node scripts/setup-cron-secret.mjs`（引数なし＝読み取りだけ）／`--apply`・`--verify`・`--off`・`--on`・`--rotate`（変更系は承認後のみ） |
| Function の Secrets 登録（承認後のみ） | `node scripts/setup-function-secrets.mjs --subject <mailto:またはhttps:> --origins <カンマ区切り>`（まず `--dry-run`） |

## 静的出力で使えないもの（課題①の教訓。要件 7.2 節）
`next.config.ts` は `output: "export"`, `trailingSlash: true`, `images.unoptimized: true` だけにする。`scripts/check-static.mjs` が違反を検出してビルドを止める。
- **使わない**：`cacheComponents` / `partialPrefetching`（PPR）/ `"use cache"` / Server Actions（`"use server"`）/ Route Handlers（`route.ts`）/ Middleware・Proxy / `next/headers`（cookies・headers）/ `rewrites`・`redirects`・`headers` 設定 / ISR（`revalidate`）/ `next/image` / `experimental` 設定。
- **create-next-app 16.4.5 の既定の next.config には `cacheComponents` と `partialPrefetching` が入っている**。作り直したときは必ず消す。
- 動的ルート（`[id]`）は使わず、ID は**クエリ文字列**で渡す（例：`/routines/detail/?id=...`）。`useSearchParams()` を使う部品は `<Suspense>` で包む。
- ログイン確認は画面側（`AuthGate`）で行い、本当の守りは RLS。
- **Windows でビルドした `out/` をアップロードしない**（Next.js 16.4.3 でプリフェッチ用のファイル名が壊れた）。デプロイは Cloudflare Pages の GitHub 連携（Linux ビルド）だけ。
- Next.js は破壊的変更が多い。API を使う前に `node_modules/next/dist/docs/` を確認する（AGENTS.md）。

## 秘密情報（要件 7.3 節、docs/plan.md 4.1 節）
| 値 | 置き場所 |
| --- | --- |
| Supabase URL、anon / publishable キー、VAPID 公開鍵 | `NEXT_PUBLIC_*`（`.env.local`、Cloudflare Pages の環境変数） |
| service_role キー、VAPID 秘密鍵、`VAPID_SUBJECT`、`CRON_SECRET`、`ALLOWED_ORIGINS` | Edge Function の secrets（`supabase secrets set`）だけ |
| send-push の URL と `CRON_SECRET`（pg_cron から使う） | Supabase Vault（`send_push_url` / `cron_secret`） |
| DB パスワード | どこにも保存しない（必要になったらダッシュボードで再設定） |
- `.env*` は Git の対象外（`.env.example` だけ含める）。秘密の値をコード・ログ・チャットに出さない。
- push 前と CI で `npm run check:secrets` を通す。

## 通知（Web Push）の守り
- 送信経路は 2 つだけ：`send-push`（pg_cron 専用。`x-cron-secret` を定数時間比較）と `test-push`（ログイン中の本人だけ。Auth サーバーでトークン検証、1分1回・1日10回）。
- 宛先・文面をリクエストから受け取らない。送信先は DB 上の本人の有効な端末だけ。
- 送信系の DB 関数（`claim_due_jobs` など）は `service_role` 専用（anon / authenticated から `revoke`）。
- Web Push の暗号化と VAPID 署名は `supabase/functions/_shared/webpush.ts`（WebCrypto のみ、外部ライブラリなし）。`tests/unit/webpush.test.ts` で参照実装（http_ece）による復号を確認している。
- `public/sw.js` は push を受けたら**必ず**通知を表示する（iOS は表示しないと購読が取り消される）。`tag` は予定 ID。

## Supabase
- プロジェクト：`routine-lab`（ref `vmlxzeraeimxgkjxivnl`、ap-northeast-1、Free）。同じ組織の `Practice` プロジェクトには**触れない**。
- マイグレーションは `supabase/migrations/*.sql`（Supabase CLI、`npx supabase`）。**適用済みのファイルは書き換えず**、修正は新しいファイルで。Docker がないためローカルの Supabase は使わない。
- テーブルの権限は自動公開に頼らず、マイグレーションで明示的に `revoke` / `grant` する。
- Edge Functions は `supabase/functions/<name>/index.ts`（Deno）。共通部品は `_shared/`。`_shared/supabase-store.ts` と各 `index.ts` 以外は Node でも動く純粋な TS にして、Vitest でテストする。
- **外部操作（link / db push / Auth 設定 / secrets / Vault / functions deploy / cron 登録）、GitHub への push・設定、Cloudflare の設定・公開は、毎回直前にユーザーの承認を得る。** CLI はエージェント実行時に `--yes` を求めるが、承認なしに付けない。

### Supabase CLI 3.0 の注意
- `db push` / `db query` は `--remote` を付けないとローカルが対象。`db push` には必ず `--skip-vault` を付ける（config.toml の Vault を上書きしないため）。確認は `db query --remote=<ref> --read-only`。
- **`npx supabase projects api-keys` をそのまま実行しない**（`--reveal` なしでも service_role などの秘密のキーが表示される）。公開キーが必要なら `setup-function-secrets.mjs` のように publishable だけを取り出す。
- Edge Function のデプロイは Docker なしの `--use-api`。`verify_jwt` は config.toml（test-push = true、send-push = false）。
- npm パッケージは公開から日の浅い版を避ける（Deno は既定で公開24時間以内の版を拒否する）。`@supabase/supabase-js` は 2.118.0 に固定（アプリと Edge Function で同じ版）。

## テスト
- 単体：`tests/unit/*.test.ts`（Vitest、node 環境）。日付・曜日・集計・提案ルール・通知の暗号化と守りは純粋関数にしてここで確認する。
- DB / RLS：`tests/db/*.test.ts`。`tests/db/harness.ts` が PGlite に全マイグレーションを適用する（Supabase の既定の権限・auth・vault・net・cron は最小の代役）。時刻に依存する規則は内部の関数（`_record_done` など、`p_now` を受け取る）で確かめる。
- ブラウザ：`tests/e2e/*.spec.ts`（Playwright、Pixel 7 / iPhone 14 の表示）。Supabase への通信は `tests/e2e/fake-supabase.ts` がすべて横取りする。
- 本番 DB の確認は `supabase/tests/phase1_smoke.sql`（必ず例外で終わり、全体が取り消される。実行は承認後のみ）。
- Phase 2 の本番 DB の確認は `supabase/tests/phase2_smoke.sql`（同じ方式。`claim_due_jobs` は呼ばない）。Phase 3 は `supabase/tests/phase3_smoke.sql`、Phase 4 は `supabase/tests/phase4_smoke.sql`。
- 本番から取り消すときは `supabase/rollback/20261110_phase4_down.sql`（Phase 4 → 3）・`20261109_phase3_down.sql`（Phase 3 → 2）・`20261108_phase2_down.sql`（Phase 2 → 1）・`20261107_phase1_down.sql`（Phase 1 → 0）。承認後のみ。`tests/db/rollback.test.ts` で確認済み。
- 通知ジョブは予定の状態からトリガー（`occurrences_sync_jobs`）が作る・取り消す。予定を変える処理を足しても、ジョブを直接いじらない。send-push の本体は `_shared/dispatch.ts`（`tests/unit/dispatch.test.ts`）。
- 分析（Phase 3）は `src/lib/analytics/` の純粋関数（`tests/unit/analytics.test.ts`）。達成率の分母は完了・見送り・未実施だけ（未確定は数えない）、0件は「データなし」、5件未満は参考値。テスト用ルーティン（`routines.exclude_from_analytics`）は分析だけから外し、予定・記録・通知には触れない。
- 改善提案（Phase 4）は `src/lib/suggestions/` の純粋関数（`tests/unit/suggestions.test.ts`）。しきい値は `thresholds.ts`。提案は画面で計算し、保存するのは承認・却下（`suggestions`、変更不可）だけ。承認は RPC `accept_suggestion` が「もとにした版が今の版」「28 日以内に同じルールを判断していない」「ルールで変えてよい項目だけ」を確かめてから版を追加する（`tests/db/phase4-suggestions.test.ts`）。版の追加は `_apply_routine_version` の1か所（手動の `_edit_routine` も経由する）。取り消しは版を消さず、元の設定で新しい版を作る（編集画面 `?revert=`）。
- iPhone 実機のテストは `docs/plan.md` 9章に従う。Android 実機はないため PC の Chrome / Edge で代替し、README に「Android 実機では未検証」と書く。
