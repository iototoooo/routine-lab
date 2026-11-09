# Routine Lab 実装計画（第2版・2026-11-04：通知の安全性／無料枠の確認／実機テストを反映）

## Context（背景）
- `docs/requirements.md`（第1版）に基づき、曜日別ルーティン・Web Push 通知・実績の蓄積・分析・改善提案を備えた PWA を作る。
- 作業フォルダ `C:\Users\iotot\dev\routine-lab` には現在 `docs/requirements.md` しかない（git 未初期化）。
- 環境確認の結果：Node v24.22.1 / npm 11.19.1 / git 2.54 / gh（`iototoooo` でログイン済み）あり。**Docker なし** → Supabase のローカル環境（`supabase start`）は使えない。リモートの Supabase プロジェクトに対して CLI でマイグレーションする。
- ユーザー回答：Supabase の空き枠は不明（Phase 0 冒頭で確認）／実機は **iPhone のみ**／GitHub は **Public**。
- 最優先は「通知が無料枠で実機に届くか」の確認。計画承認後の最初の工程（Phase 0）を通知の試作にする。
- 要件定義書は変更しない。課題①（`addone-consultation`）には触れない。

### 最終確認で追加された必須条件（第2版で反映）
1. **通知の安全性**：テスト用を含むすべての送信経路に、認証・本人確認・送信回数制限を付ける。第三者が通知を送れる経路を作らない。VAPID 秘密鍵・service_role キーは GitHub・ブラウザ・公開ファイルに出さない（→ 4.1 節）。
2. **Supabase の無料枠**：Phase 0 の最初に空きプロジェクト数を確認する。空きがなければ既存プロジェクトを削除・流用せず、代替案を提示して判断を待つ（→ 5.1 節）。
3. **実機テスト**：iPhone 実機で「アプリを閉じた状態での通知受信」と「通知タップによる記録画面への遷移」を必須とする。Android は PC の Chrome/Edge で代替検証し、Android 実機は未検証であることを README に明記する（→ 9.1 節）。
4. **進め方**：作業は `C:\Users\iotot\dev\routine-lab` に限定。通常の実装・テスト・軽微な修正はまとめて進め、外部サービス（Supabase・GitHub・Cloudflare）の作成・設定変更・公開は **直前に必ず承認を得る**（→ 12 節）。

---

## 0. 未決事項（要件 13章）への回答（推奨案）

| # | 未決事項 | 決定案 | 理由 |
|---|---|---|---|
| 1 | 通知の送信先 | **Supabase Edge Function（第1案）**。Phase 0 で実測して確定。Workers は不採用（第2案として記録のみ） | Edge Function は CPU 2秒／実行時間 150秒（無料）で、ECDH＋AES-GCM＋ES256 署名に十分。Workers 無料は CPU 10ms で、暗号化を端末数ぶん行うと超える恐れ。Cron Trigger の枠も消費しない。DB と同じ場所で完結し secrets も1か所 |
| 2 | 分析の計算場所 | **画面側の TypeScript（純粋関数）** | データ量が小さい（年数千行）。Vitest で単体テストしやすい。SQL ビューは RLS（security_invoker）の取得用にだけ使う |
| 3 | 予定の作成 | **両方**：pg_cron（毎日 0:00 JST）＋ アプリ起動時・ルーティン保存時に RPC `ensure_occurrences()` | 同じ SQL 関数を呼ぶので結果は同じ。一意制約で重複しない。cron が止まっても開けば作られる |
| 4 | 未実施の期限 | **予定日の翌日の終わり（JST 24:00）** で確定。0:05 JST の cron で `planned_date <= 今日-2` を missed に | 要件どおり。「明日の同じ時刻」への延期も期限内に収まる |
| 5 | ライブラリ | 本体：`@supabase/supabase-js` のみ追加。グラフは **自作の SVG/CSS 棒グラフ＋数値表**（ライブラリなし）。Web Push 送信は Edge Function 内で `jsr:@negrel/webpush`（WebCrypto ベース）を第1候補、ダメなら `npm:web-push`。開発用：`vitest`, `@playwright/test`, `supabase`（CLI）, `web-push`（VAPID 鍵生成のみ） | 追加パッケージ最小。日付処理は JST=UTC+9 固定なので自作（date-fns 不要） |
| 6 | マイグレーション | **Supabase CLI（devDependency, `npx supabase`）＋ `supabase/migrations/*.sql`** を Git 管理。`supabase db push` でリモートへ適用 | Docker 不要の操作だけ使う。適用済みの SQL は書き換えず、修正は新しいマイグレーションで |
| 7 | 開発／本番の分離 | 空き2つ → `routine-lab-dev` と `routine-lab-prod`。空き1つ → 1つだけ（テストユーザーで分離）。**Phase 0 冒頭でダッシュボードを確認してもらう** | 課題①のプロジェクトを止めたり消したりしない |
| 8 | 実機確認 | Cloudflare Pages の **プレビュー URL（HTTPS）** で iPhone のホーム画面に追加して確認 | iOS はホーム画面 PWA＋HTTPS が必須 |

---

## 1. 全体アーキテクチャ

```
[iPhone PWA / ブラウザ]  Next.js 静的出力（out/）── Cloudflare Pages（GitHub 連携で Linux ビルド）
   │ supabase-js（anon key）: SELECT は RLS、書き込みは RPC 経由
   ▼
[Supabase Postgres]  RLS ＋ SECURITY DEFINER の RPC（auth.uid() を必ず検証）
   ├ pg_cron 15:00 UTC  → ensure_occurrences_all()（今日・明日の予定＋initial ジョブ）
   ├ pg_cron 15:05 UTC  → close_missed()
   └ pg_cron 毎分        → due ジョブがある時だけ pg_net で Edge Function を呼ぶ
[Edge Function send-push]（service_role, VAPID 秘密鍵は secrets）
   claim_due_jobs() → 期限切れ判定 → 全有効端末へ Web Push → 結果記録・404/410 無効化
[public/sw.js]  push → showNotification(tag=予定ID) / notificationclick → /record/?o=ID
```

### 書き込みは RPC に限定する（P-01・P-03・P-06 を DB で守る）
- 全表で RLS 有効。クライアントには原則 **SELECT ポリシーのみ**（`user_id = auth.uid()`）。
- 例外：`profiles` の一部列の UPDATE、`push_subscriptions` の INSERT/UPDATE（本人の行だけ）。
- 状態を変える操作はすべて Postgres 関数（`SECURITY DEFINER` ＋ `search_path` 固定＋冒頭で所有者チェック）。これで「版の UPDATE 不可」「実績は上書きせず新しい行」「イベントは必ず記録」を DB 側で保証する。
- `service_role` 専用の関数（`claim_due_jobs` 等）は `revoke execute ... from anon, authenticated` する。

---

## 2. データ構造（要件 6.1 をもとに確定させる点）

- **全表に `user_id`** を持たせる（要件の表で抜けている `routine_versions` / `executions` / `occurrence_events` にも追加。RLS を単純にするため）。
- `routine_versions`：作成後は不変。期間の重複禁止は `exclude using gist (routine_id with =, daterange(valid_from, valid_to, '[)') with &&)`（`btree_gist`）。`valid_to` を閉じる操作は `edit_routine` RPC だけが行う。
- `occurrences`：`unique (routine_id, planned_date)`。`planned_start_at = (planned_date + start_time) at time zone 'Asia/Tokyo'`。
- `executions`：修正は新しい行＋旧行に `superseded_by`。`executed_date` は JST、`is_late_day = executed_date > planned_date`（生成列）。
- `occurrence_events`：すべての状態変化（notified/postponed/skipped/done/missed/edited/cancelled）。延期の `remind_at`・理由はここに残る。
- `notification_jobs`：`unique (occurrence_id, kind, fire_at)`。列に `locked_at` を追加（`sending` のまま止まったジョブの回収用）。
- `notification_deliveries`（追加）：ジョブ×端末ごとの送信結果（HTTP ステータス）。F-306 の記録用。
- `reason_codes`：定数（TS と SQL の check 制約で共有：`no_time / tired / forgot / plans / sick / unmotivated / other`）。

### 主な RPC
| 関数 | 内容 |
|---|---|
| `create_routine(...)` / `edit_routine(routine_id, settings, valid_from, reason, source, suggestion_id)` | 版を追加し前の版の `valid_to` を閉じる。`valid_from` 以降で **未通知・未記録（status=scheduled かつイベントなし）** の予定は新しい版に合わせて更新し、通知ジョブを差し替え（旧ジョブは cancelled）。それ以外は残す。最後に `ensure_occurrences` |
| `archive_routine` / `restore_routine` | `archived_at` を設定、未来の scheduled 予定は `cancelled`、pending ジョブも cancelled |
| `ensure_occurrences(user)` / `ensure_occurrences_all()` | JST の今日・明日について、その日に有効な版の曜日なら予定＋initial ジョブを `on conflict do nothing` で作成 |
| `record_done(occ, actual_start_at, duration_min)` | execution 追加、status=done、pending ジョブ取消、イベント記録。翌日以降でも可 |
| `postpone(occ, remind_at, reason_code, reason_text)` | status=postponed、`next_remind_at` 更新、snooze ジョブ追加（前の snooze の pending は取消）、イベント記録 |
| `skip(occ, reason_code, reason_text)` | status=skipped、ジョブ取消、イベント |
| `close_missed()` | `planned_date <= JST今日-2` かつ未確定を missed に、イベント記録 |
| `claim_due_jobs(limit)`（service_role のみ） | `FOR UPDATE SKIP LOCKED` で `fire_at <= now()` の pending を sending に。期限切れ（initial は planned_start_at＋60分、snooze は fire_at＋60分）は expired。予定が既に done/skipped/missed なら cancelled。`sending` が5分以上のものは pending に戻す（attempts<3） |
| `finish_job(job_id, result)` | sent/failed、`occurrences.status` を notified に（initial の場合）、イベント記録 |

---

## 3. 日本時間の扱い（`src/lib/time/`）
- `jstDate(instant)`：UTC＋9h した日付文字列 `YYYY-MM-DD`。`isoWeekday(dateStr)`（1=月〜7=日）。
- `plannedStartAt(dateStr, "HH:MM")`：JST の日時 → UTC instant。
- `addDays(dateStr, n)`、`timeBand(start_time)`（4–7/7–10/10–14/14–18/18–22/22–4）。
- SQL 側も `now() at time zone 'Asia/Tokyo'` で同じ定義にし、同じテストケース（表）で TS と SQL を両方確認する。
- cron は UTC で書く（0:00 JST = `0 15 * * *`）。
- テスト必須ケース：14:59/15:00 UTC の境界、23:30 開始 60 分（予定日は開始日）、日曜→月曜、月末・年末、翌日実施（is_late_day）。

---

## 4. 通知方式（iPhone / Android）
- **購読**：設定画面のボタン押下時のみ `Notification.requestPermission()` → `pushManager.subscribe({userVisibleOnly:true, applicationServerKey: VAPID公開鍵})` → `push_subscriptions` に upsert（endpoint 一意）。
- **iOS 判定**：`navigator.standalone` / `display-mode: standalone` でなければ「共有→ホーム画面に追加」の案内を表示（F-303）。拒否済み（`denied`）なら再追加の手順を案内。
- **sw.js**：`push` で **必ず** `showNotification`（iOS は表示しないと購読が取り消される）。`tag = occurrence_id`, `renotify: true`, `data.url = /record/?o=<id>`。`notificationclick` で既存ウィンドウを focus＋navigate、なければ `openWindow`。actions（F-309）は Could なので後回し。
- **ペイロード**：`{occurrenceId, title: ルーティン名, body: "7:00〜 15分", url}`。ロック画面に出る旨を設定画面で案内。
- Android は Chrome 経由（FCM）で同じコードが動く。

### 二重通知・失敗・遅延への対策（論点7）
| 問題 | 対策 |
|---|---|
| 同じジョブを2回作る | `unique (occurrence_id, kind, fire_at)` ＋ `on conflict do nothing` |
| cron の重複実行で二重送信 | `FOR UPDATE SKIP LOCKED` で sending にしてから送る。送信は claim 済みの行だけ |
| 複数端末・再通知の重複表示 | `tag = occurrence_id` で端末上で置き換え |
| 送信途中で関数が落ちる | `locked_at` が5分超の sending を pending に戻す（最大3回、以後 failed） |
| 端末の購読切れ | 404/410 で `disabled_at` を設定。その他のエラーは `last_error` に記録 |
| cron/配送の遅れ | 予定から60分過ぎたら expired（送らない）。アプリ起動時に今日・未記録を必ず表示（F-310） |
| 記録済みなのに通知 | claim 時に予定の状態を確認し cancelled に |

### 4.1 通知の安全性（必須）
**送信経路は2つだけにし、どちらも認証を必須とする。** 任意の宛先・任意の文面を受け取る API は作らない。

| 経路 | 呼び出し元 | 認証・本人確認 | 送信先・文面 | 回数制限 |
|---|---|---|---|---|
| ① 定期送信 `send-push`（Edge Function） | pg_cron（pg_net）だけ | `verify_jwt` に加え、ヘッダーの `CRON_SECRET` を定数時間比較で検証。秘密は Supabase Vault と Function secrets にだけ置く。不一致は 401 で何もしない | `claim_due_jobs` が返したジョブの持ち主の端末だけ。文面は DB の予定から関数内で組み立てる（リクエストからは受け取らない） | 1回の起動で最大 N 件（例 50）。ジョブ単位で一意制約＋SKIP LOCKED |
| ② テスト送信 `test-push`（Edge Function、試作・設定画面用） | ログイン中の本人のブラウザ | `verify_jwt: true`＋関数内で `auth.getUser(jwt)` によりユーザーを確定。**リクエスト本文の user_id・endpoint は受け付けない** | 確定したユーザー本人の有効な端末だけ。文面は固定（「テスト通知」） | DB 関数 `consume_test_push_quota()` で **1ユーザー 1分に1回・1日10回まで**（`push_test_log` 表に記録）。超過は 429 |

その他の対策：
- Edge Function の CORS は本番 URL とプレビュー URL のパターンだけ許可（CORS は補助。本当の守りは JWT と回数制限）。
- `push_subscriptions` の INSERT/UPDATE は RLS で `user_id = auth.uid()` に限定。他人の端末を登録・閲覧できない。
- `claim_due_jobs` / `finish_job` など送信系の関数は `revoke execute from anon, authenticated`（service_role 専用）。
- エラーログに endpoint 全体・鍵・JWT を出さない（endpoint は末尾数文字だけ）。
- 試作で使ったテスト送信は本番でも同じ制限のまま残す（制限なしの一時 API を作らない）。

**秘密情報の置き場所**
| 値 | 置き場所 | 出してはいけない場所 |
|---|---|---|
| VAPID 秘密鍵、service_role キー、CRON_SECRET | Supabase Function secrets（`supabase secrets set`）、CRON_SECRET は Vault にも | Git、`.env.local` 以外のファイル、`NEXT_PUBLIC_*`、`out/`、ログ、チャットへの貼り付け |
| VAPID 公開鍵、Supabase URL、anon key | `NEXT_PUBLIC_*`（Cloudflare Pages の環境変数、`.env.local`） | — （公開して問題ない値） |

- VAPID 鍵は `node` のワンライナー（`web-push` の `generateVAPIDKeys`）でローカル生成し、**ファイルに保存せず** その場で `supabase secrets set` に渡す手順にする（実行時に承認を取る）。
- 混入防止：`scripts/check-secrets.mjs`（`service_role`、JWT 形式の文字列、`VAPID_PRIVATE`、`-----BEGIN` などを Git 管理下ファイルと `out/` から検出）を `prebuild`/`postbuild` と CI で実行。GitHub の Secret scanning / Push protection（Public リポジトリで無料）を有効にする。
- `.gitignore` に `.env*`（`.env.example` だけ除外）、`supabase/.temp/`、`supabase/.env`。

---

## 5. 無料枠での実現性（論点5・6）

### 5.1 Supabase の空き枠確認（Phase 0 の最初の作業）
1. ユーザーにダッシュボード（または承認を得て `npx supabase projects list`）で、組織ごとの有効な無料プロジェクト数を確認してもらう。**この確認で何かを作成・変更はしない。**
2. 空き2つ → `routine-lab-dev` / `routine-lab-prod`。空き1つ → 1プロジェクト運用（テスト用ユーザーで分離）。いずれも作成の直前に承認を得る。
3. **空き0 → 既存プロジェクトの削除・一時停止・流用はしない。** 次の代替案を提示し、判断を待つ（その間は Supabase に依存しない作業＝純粋関数・UI の試作・sw.js だけ進める）：
   - 案A：新しい Supabase 組織を作成して、その無料枠を使う（無料枠が組織単位の場合。作成前に規約・上限を確認）
   - 案B：既存プロジェクトの持ち主として、ユーザー自身が不要なプロジェクトを整理するか判断する（Claude は操作しない）
   - 案C：構成の見直し（例：DB を別の無料サービスへ）— 要件 7章の変更になるため、最後の選択肢として相談
- **Edge Function 呼び出し回数**：毎分無条件だと 約43,200回/月（枠50万の約9%）。さらに **pg_cron の SQL で「due な pending ジョブがある時だけ」pg_net で呼ぶ** ようにし、実際の呼び出しは1日数回〜数十回に抑える。
- **CPU**：1通知あたり ECDH＋HKDF＋AES-GCM＋ES256 で数 ms。Edge Function（CPU 2秒）で十分。Phase 0 で実測しログに残す。
- **pg_cron / pg_net**：無料プランで利用可。毎分の cron は DB 内の軽い SELECT のみ。
- **認証メール**：Supabase 標準 SMTP は送信数が少なく（1時間に数通）、送り先も組織メンバーのアドレスに限られる。本人1人なら足りる。RLS テスト用の2人目は **管理 API（service_role, テスト時のみ）でユーザーを作成** し、メールは使わない。
- **一時停止**：毎日使えば止まらない想定。止まったときの再開手順を README に書く。
- **Workers 案を採らない理由**：CPU 10ms が暗号処理＋複数端末で不安。Phase 0 で Edge Function が NG だった場合のみ、Workers の試作に切り替える（判断基準は Phase 0 に記載）。

---

## 6. 静的出力と Cloudflare Pages の互換性（論点1・12：課題①の再発防止）

`next.config.ts`：
```ts
output: "export", trailingSlash: true, images: { unoptimized: true }
// cacheComponents / PPR / experimental 系は一切書かない
```
再発防止策：
1. **禁止事項を CLAUDE.md に明記**（Server Actions, Route Handlers, middleware/proxy, `cookies()`/`headers()`, 動的ルート `[id]`, `next/image` 最適化, `cacheComponents`, PPR）。
2. **`scripts/check-static.mjs`**：`src/` を走査し、`"use server"`、`app/**/route.ts`、`middleware.ts`/`proxy.ts`、`[` を含むディレクトリ、`next/headers` の import を検出したら失敗。`npm run build` の前に必ず走らせる（`prebuild`）。
3. **ビルド後チェック**：`out/` に `index.html`, `login/index.html`, `record/index.html`, `routines/edit/index.html` などが揃っているか、`out/` に秘密情報（`service_role`, `VAPID_PRIVATE` 等の文字列）がないかを `scripts/check-out.mjs` で確認（`postbuild`）。
4. `useSearchParams()` を使うページは `<Suspense>` で包む（静的出力のビルドエラー対策）。
5. **Windows でビルドした `out/` はアップロードしない**（Next.js 16.4.3 の不具合）。デプロイは Cloudflare Pages の GitHub 連携（Linux）だけ。加えて GitHub Actions（ubuntu）で lint/test/build を回す。
6. Next.js のバージョンは `create-next-app` 時点のものを **exact 固定**（`^` を外す）。
7. Pages 側のビルド設定：Build command `npm run build`、Output `out`、環境変数 `NODE_VERSION=24`、`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_VAPID_PUBLIC_KEY`。
8. `public/_headers` で `sw.js` を `Cache-Control: no-cache`、`manifest.webmanifest` の Content-Type を指定。

### create-next-app と既存 docs/ の衝突
- 一時フォルダ（スクラッチ）で `create-next-app` を実行 → 生成物をプロジェクトへコピー（`docs/` はそのまま）。その後 `git init`。その後に `/init` で CLAUDE.md を作り、`AGENTS.md` は残す（要件12章）。

---

## 7. ディレクトリ構成（予定）
```
routine-lab/
  docs/requirements.md（変更しない）  docs/plan.md（本計画の写し）
  CLAUDE.md  AGENTS.md  README.md  .gitignore（.env* を除外）  .env.example
  next.config.ts  scripts/check-static.mjs  scripts/check-out.mjs
  public/ sw.js  manifest.webmanifest  icons/  _headers
  src/app/ layout.tsx  page.tsx(今日)  login/  record/  routines/{,edit,detail,compare}/  analytics/  suggestions/  settings/
  src/components/ BottomTabs, AuthGate, OccurrenceCard, BarChart(SVG), StatTable ...
  src/lib/ supabase/client.ts  time/  push/subscribe.ts  domain/(状態・理由コード)
           analytics/  suggestions/rules.ts  compare/
  supabase/ config.toml  migrations/*.sql  functions/send-push/index.ts
  tests/unit/*.test.ts  tests/e2e/*.spec.ts  tests/db/*.test.ts（RLS）
  .github/workflows/ci.yml
```

---

## 8. Phase ごとの計画

### Phase 0：通知の試作（承認後の最初の工程・Go/No-Go 判定）
**目的**：iPhone（ホーム画面 PWA）で、アプリを閉じた状態でも Edge Function からの Web Push が届き、タップで記録画面が開くことを確認する。
（【承認】＝その直前にユーザーの承認を得る外部操作）
1. **Supabase の空き枠確認**（5.1 節）。空きがなければ代替案を提示して停止。
2. ローカル作業（承認不要）：スクラッチで `create-next-app` → `routine-lab` に取り込み、`git init`、静的出力設定、check スクリプト、`public/sw.js`, `manifest.webmanifest`, アイコン、ログイン（OTP）と試作ページ `/settings/`（購読ボタン・テスト送信ボタン）、Edge Function `send-push` / `test-push` のコード、最小マイグレーション（`profiles`, `push_subscriptions`, `push_test_log`, `notification_jobs` の最小版＋RLS＋回数制限関数）。
3. 【承認】Supabase プロジェクト作成 → `link` → `db push` → Auth の OTP 設定。
4. 【承認】VAPID 鍵生成と `supabase secrets set`（秘密鍵はファイルに残さない）、Edge Function の deploy、Vault に CRON_SECRET。
5. 【承認】GitHub（Public）リポジトリ作成・push（push 前に `check-secrets` を実行）。
6. 【承認】Cloudflare Pages の GitHub 連携と環境変数設定（ユーザー操作を案内）。
7. 実機検証（下記）。Edge Function の所要時間・CPU をログで計測。`@negrel/webpush` が動かなければ `npm:web-push` に切り替え。
8. pg_cron＋pg_net で「1分後の通知ジョブ」を送る経路を確認（cron→関数→端末）。

**確認項目**
- iPhone 実機（必須）：ホーム画面追加→ボタンで許可→**アプリをスワイプで完全に閉じた状態**で、テスト送信（予約）と cron 経由の通知が届く／ロック中に届く／通知タップで `/record/?o=<ID>` が開く（閉じた状態からの起動と、バックグラウンドからの復帰の両方）／同じ tag で2回送ると1件に置き換わる。
- 安全性：未ログイン・他人の JWT・CRON_SECRET なしで `send-push` / `test-push` を呼ぶと 401、回数超過で 429、他人の端末に届かないこと（curl とテスト用ユーザー2人で確認）。
- PC Chrome / Edge（Android の代替）：購読・受信・タップ遷移・購読解除後の 404/410 による無効化。
**Go 条件**：iPhone で閉じた状態でも届く＆タップで記録画面が開く、安全性の確認がすべて通る、Edge Function 1回の CPU に余裕がある。**No-Go 時**：ライブラリ変更→それでも不可なら Workers 試作→それでも不可なら「アプリ内表示のみ＋通知は補助」に要件調整を相談。

#### Phase 0 の実績（2026-11-07 完了・判定 **Go**）
詳細は `docs/test-report.md`。
- iPhone 実機（iOS 18.7）：アプリを完全に終了・ロックした状態で、cron 経由の予約通知を受信。タップで記録画面が開いた。送信処理は 1 回 1.8 秒（2台）。
- 安全性：未ログイン・偽トークン・公開キーだけ・合言葉なし／誤りはすべて拒否、送信用の DB 関数は一般ユーザーから実行不可、回数制限（429）を確認。
- **計画からの変更点**
  - Supabase は空き枠の確認の結果、`routine-lab` の1プロジェクト運用（ref `vmlxzeraeimxgkjxivnl`、ap-northeast-1）。dev / prod は分けず、テスト用ユーザーで分離する。
  - Web Push は外部ライブラリを使わず、`_shared/webpush.ts` に WebCrypto で実装（`@negrel/webpush` / `npm:web-push` は不採用。`web-push` は鍵生成と復号テストの参照実装だけに使う）。
  - send-push は `verify_jwt = false`＋`x-cron-secret` の定数時間比較（Supabase 公式の「Securing Edge Functions」の推奨どおり。pg_net から JWT を送らないため）。test-push は `verify_jwt = true`＋`getUser`。送信先は許可した Push サービスのドメインだけ（SSRF 対策）。
  - 合言葉は Vault の中で乱数から作り、Function の `CRON_SECRET` にコピーする（`scripts/setup-cron-secret.mjs`。SQL やログに値を出さない）。止めるときは Vault の `send_push_url` を消す（`--off`）。
  - `dispatch_due_push` は期限切れのジョブを先に `expired` にしてから呼ぶ（マイグレーション `20261106000000`。失敗が続いても毎分呼び続けない）。
  - 認証メールは無料の Resend SMTP（送信元 `onboarding@resend.dev`、宛先は本人だけ）。2026-06 以降、新しい無料プロジェクトはカスタム SMTP なしではメールテンプレートを変えられないため。新規登録は OFF、コードは6桁・有効 600 秒、ログイン画面は `shouldCreateUser: false`。
- **後の Phase に回した確認**：他人の端末に届かないこと（Phase 1 の DB テスト）、tag による置き換え・延期の再通知・完了後の停止・PC Chrome（FCM）・404/410 の無効化（Phase 2）。

### Phase 1：土台とデータ保存（F-001〜003, 101〜103, 105, 201〜203, 310, 401〜406, 408）
- **実装**：全テーブル・RLS・RPC のマイグレーション、pg_cron（予定作成・missed 確定）、`AuthGate`（未ログインは `/login/` へ）、OTP ログイン（`signInWithOtp` → `verifyOtp({type:'email'})`、メールテンプレートを `{{ .Token }}` に変更する手順を README に）、ログアウト、今日画面（今日の予定＋前日の未記録）、ルーティン一覧・編集（版・適用開始日・変更理由）・アーカイブ・詳細（版履歴）、記録画面（完了：予定時刻/今・所要時間・タイマー、延期5種＋理由、見送り＋理由）。
- **ファイル**：`supabase/migrations/0001_schema.sql`, `0002_rls.sql`, `0003_rpc.sql`, `0004_cron.sql`、`src/lib/time/*`, `src/lib/domain/*`, 各画面。
- **テスト**：
  - Vitest：JST 日付・曜日・境界・延期時刻計算（「明日の同じ時刻」等）・状態遷移。
  - DB テスト（`tests/db`, dev プロジェクトに対して）：ユーザーA/B を作成し、B が A の行を SELECT/RPC できないこと、版が UPDATE できないこと、`ensure_occurrences` を2回呼んでも重複しないこと、編集時に過去・通知済みの予定が変わらないこと。
  - Playwright（ローカル `npx serve out` ＋ dev Supabase）：ログイン後の主要フロー（OTP 部分はテスト用ユーザーのセッション注入で代替）。
- **完了条件**：完成条件 1〜4 を満たす。CI（ubuntu）で test/build が通り、Pages の本番 URL で動く。

#### Phase 1 の実績（2026-11-07 完了）
詳細は `docs/phase1-plan.md`（8〜11章）と `docs/test-report.md`。
- 5 表（routines / routine_versions / occurrences / executions / occurrence_events）＋分析用ビュー `occurrence_facts`、書き込みは RPC だけ、履歴は DB のトリガーで保護。cron は 0:00 / 0:05 JST。
- **計画からの変更点**：DB テストは dev プロジェクトではなく、手元の PGlite（WASM の PostgreSQL）に全マイグレーションを適用して行う（1 プロジェクト運用のため）。本番では、最後に必ず取り消すスモーク SQL で確認する。Playwright も Supabase への通信を偽の応答に置き換えて行う。通知ジョブは作らず Phase 2 に回した（延期の時刻は `next_remind_at` とイベントに保存済み）。
- iPhone 実機で登録・表示・完了・延期・見送り・変更履歴・比較・テスト通知の 9 項目が成功。

### Phase 2：通知の本実装（F-301〜307, 302, 303, 310）
- **実装**：`notification_jobs`/`notification_deliveries`、`claim_due_jobs`/`finish_job`、毎分 cron（due がある時だけ pg_net）、`send-push` 本番版（複数端末、404/410 無効化、期限切れ、回収）、記録/延期/見送り時のジョブ取消・snooze 追加、設定画面（許可・端末一覧・解除・iOS 案内・ロック画面の注意）、今日画面に状態（未通知・通知済み・延期中…）。
- **テスト**：Vitest（期限切れ判定・ペイロード生成・期限の純粋関数）、DB テスト（同じジョブを2並列で claim しても1回だけ／記録後のジョブが cancelled／sending の回収）、Edge Function を手動起動して `notification_deliveries` を確認、認証なし・他人・回数超過の拒否テスト（Phase 0 と同じ項目を自動テスト化）、iPhone 実機で **アプリを閉じた状態** の「予定時刻」「10分後延期」の通知とタップ遷移、重複しないこと。PC Chrome/Edge で同じ項目を代替確認。
- **完了条件**：完成条件 5 のうち iPhone 実機分をすべて満たす。Android は PC Chrome/Edge での代替検証結果を記録し、README に「Android 実機では未検証」と明記。

#### Phase 2 の実績（2026-11-08 完了）
詳細は `docs/phase2-plan.md`（10〜14章）と `docs/test-report.md`。
- 通知ジョブは予定の状態からトリガーで作る・取り消す（理由つき）。send-push は送る直前に予定と照合し、一時的な失敗は期限内に最大 3 回再試行、404/410 は端末を無効化。今日の画面と記録画面に通知の状態を表示。
- **計画からの変更点**：通知ジョブに取り消しの理由と時刻の列を追加（分析用）。Phase 1 の「同じ日に 2 回編集すると 2 回目が予定に反映されない」不具合を修正。設定画面の端末一覧・解除は Phase 0 のものをそのまま使用。
- iPhone 実機で予定時刻の通知・ロック中の受信・タップで記録画面・延期の再通知・完了 / 見送り後に届かないことを確認。実機未検証：「10分後」での再通知、編集による時刻変更と通知の付け直し、送信待ちの通知の完了・見送りによる取り消し（別途確認）。PC Chrome（FCM）・404/410 の本番での無効化も未検証。

### Phase 3：分析（F-501〜506, 509）
- **詳細計画**：`docs/phase3-plan.md`（2026-11-08 承認、2026-11-09 完了。F-507・F-508 の集計も前倒し）。
- **実装**：`src/lib/analytics/`（純粋関数）：達成率（done ÷ (done+skipped+missed)、postponed は最終結果で、未確定は除外）、日別推移、曜日別、時間帯別（予定開始時刻の JST で分類）、遅延（実開始−予定開始の中央値・平均、±10分以内の割合、翌日以降の割合）、件数<5 で `isReference=true`。取得は supabase-js で期間・ルーティン条件付き SELECT（必要ならビュー `occurrence_facts`, `security_invoker=true`）。画面 `/analytics/`：期間（7日/4週/12週/任意）・ルーティンの絞り込み、SVG 棒グラフ＋数値表、「参考値」バッジ。
- **テスト**：Vitest（固定データで各指標、0件、全部延期→完了、翌日実施、22–4時帯の境界）、Playwright（フィルタ操作で表が変わる）。
- **完了条件**：完成条件 6。

#### Phase 3 の実績（2026-11-09 完了）
詳細は `docs/phase3-plan.md`（10〜14章）と `docs/test-report.md`。
- 分析は画面側の純粋関数（`src/lib/analytics/`）で計算。達成率の分母は完了・見送り・未実施だけ（未確定は別に表示）、0件は「データなし」、5件未満は参考値。「予定どおり」で入れた記録は実測と分けて数える。
- **計画からの追加**：テスト用のルーティンを分析だけから外す印（`routines.exclude_from_analytics` と `set_routine_analytics`）、理由の集計用ビュー `occurrence_reason_facts`、ルーティン詳細の「版ごとの集計」と同じ日数での比較（F-507・F-508・F-701/702 の一部を前倒し）。
- iPhone 実機テスト 9 項目すべて成功（2026-11-09）。未検証：記録が多いときの見え方、比較の数値の実機確認、Android 実機・PC での表示。Phase 2 の未検証の項目もそのまま残る。

### Phase 4：改善提案と比較（F-507, 508, 601〜604, 701〜702, 801）
- **詳細設計**：`docs/phase4-plan.md`（2026-11-09 承認、2026-11-09 完了）。
- **実装**：`src/lib/suggestions/rules.ts`：しきい値は `thresholds.ts` に定数化。まず **R-01（慢性的な遅れ）・R-03（所要時間の不足）・R-02（曜日の不調）** の3つ、余裕があれば R-04〜06。入力＝直近4週の事実データ、出力＝`{ruleId, evidence, current, proposed}`。却下から4週間以内の同内容は除外。`/suggestions/`：根拠と前後の設定 → 確認画面 → 承認で `accept_suggestion` RPC（`suggestions` 保存＋`edit_routine(source='suggestion')`）、却下で `reject_suggestion`。比較 `/routines/compare/`：2つの版の有効期間から同じ長さ（変更前の直近4週 vs 変更後の最初の4週）で指標を並べ、件数不足を注意表示。所要時間の差・理由の内訳。JSON/CSV 書き出し（クライアントで生成してダウンロード）。
- **テスト**：Vitest（各ルールの成立・不成立・境界値・件数5未満・15分丸め・却下期間）、DB テスト（承認時だけ版が増える、却下では増えない）、Playwright（提案→確認→承認→版履歴に「提案」と出る）。
- **完了条件**：完成条件 7（提案2種類以上）。最後に完成条件 8〜10（無料枠のみ・秘密鍵なし・README）を確認。

#### Phase 4 の実績（2026-11-09 完了）
詳細は `docs/phase4-plan.md`（9〜14章）と `docs/test-report.md`。
- ルールは R-01（開始の遅れ）・R-02（曜日の不調、参考傾向）・R-03（所要時間の不足）の 3 つ（R-04〜06 は作らない）。提案は画面で計算し、確認画面で承認したときだけ版を追加。却下・承認は `suggestions` に記録（変更不可）し、同じルーティン・同じルールは 28 日間出さない。取り消しは元の設定で新しい版を作る。比較画面 `/routines/compare/`、JSON・CSV の書き出し。
- **計画からの変更点**：DB でも「もとにした版が今の版」「ルールごとに変えてよい項目」「28 日」を確認する。版の追加を `_apply_routine_version` の1か所にまとめた。取り消し SQL は判断記録・提案由来の版があると止まる（本番適用前の確認で見つけて修正）。書き出しに端末の情報を含めない。
- iPhone 実機テスト 9 項目すべて成功。未検証：実際の提案の承認・却下と取り消し、実データによる効果の確かめ（記録がたまってから）。Phase 2・3 の未検証の項目もそのまま残る。全体の照合は `docs/test-report.md` の「アプリ全体の最終確認」。

---

## 9. テスト方針まとめ（論点10）
| 種類 | 道具 | 対象 |
|---|---|---|
| 単体 | Vitest | 日付・曜日・延期時刻・集計・提案ルール・比較（UI 非依存の純粋関数） |
| DB／RLS | Vitest＋supabase-js（dev プロジェクト、テスト用ユーザー2人） | RLS の越境不可、RPC の不変条件、重複防止、並列 claim |
| ブラウザ | Playwright（`out/` を静的配信して実行、Chromium＋WebKit のモバイル表示） | ログイン後の主要フロー、44px タップ領域、3タップで記録 |
| 実機 | iPhone（ホーム画面 PWA、プレビュー/本番 URL） | 通知の受信・タップ遷移・重複なし・延期の再通知（9.1 節） |
| 代替 | PC Chrome / Edge | Android の代わりに受信・タップ遷移・購読無効化 |
| 安全性 | Vitest＋fetch（テスト用ユーザー2人） | 送信 API の 401/403/429、他人の端末に届かない、秘密情報の混入なし |
| 静的出力 | `check-static.mjs` / `check-out.mjs`＋CI（ubuntu） | 禁止機能の混入、出力ファイル、秘密情報の混入 |

### 9.1 実機テストの必須項目（iPhone）
| # | 手順 | 期待結果 |
|---|---|---|
| 1 | Safari で URL を開く（ホーム画面未追加） | 「ホーム画面に追加」の案内が出る |
| 2 | ホーム画面に追加 → 起動 → 設定で許可ボタン | 許可ダイアログ → 端末一覧に登録される |
| 3 | 数分後の予定を作る → **アプリを App スイッチャーから完全に閉じる** | 予定時刻（最大1〜2分遅れ）に通知が届く |
| 4 | 3 の通知をタップ | アプリが起動し、その予定の記録画面が開く |
| 5 | 記録画面で「10分後」に延期 → アプリを閉じる | 10分後に再通知が届き、タップで同じ記録画面 |
| 6 | 端末をロックした状態で 3 を繰り返す | ロック画面に届く |
| 7 | 完了を記録した後 | その予定の通知は以後届かない |
| 8 | 同じ予定に2回送信（テスト） | 通知センターでは1件に置き換わる |
- 結果は日時・iOS バージョンとともに `docs/test-report.md` に記録し、README に要約する。
- **Android**：PC の Chrome / Edge で 2〜5・7・8 を代替検証。README の「通知の対応条件」に「Android 実機では未検証（PC の Chrome/Edge で代替検証済み）」と明記する。

コマンド（予定）：`npm run dev` / `npm run build` / `npm test` / `npx vitest run tests/unit/time.test.ts`（1件）/ `npm run test:db` / `npm run test:e2e`。

---

## 10. 公開手順（論点11）
1. `git init` → `.gitignore`（`.env*`, `out/`, `.next/`, `supabase/.temp/`）→ 初回コミット。
2. `npm run check:secrets` を通してから、【承認】`gh repo create routine-lab --public --source . --push`。Secret scanning / Push protection を有効化。
3. Cloudflare ダッシュボード → Workers & Pages → Pages → GitHub 連携でリポジトリを選択、Framework preset「Next.js (Static HTML Export)」、Build `npm run build`、Output `out`、環境変数（公開値のみ）を設定（ユーザー操作）。
4. Supabase：`npx supabase login` → `link --project-ref` → `db push` → `functions deploy send-push` → `secrets set VAPID_PRIVATE_KEY ... CRON_SECRET ...`。pg_net から関数を呼ぶ URL/秘密は Vault に保存。
5. Supabase Auth の Site URL／Redirect URL に Pages の URL を登録、メールテンプレートを OTP 用に変更。
6. push → プレビュー URL で確認 → main へマージで本番。

---

## 11. リスクと確認事項
| リスク | 対応 |
|---|---|
| **Android 実機がない**（完成条件5は Android 実機を含む） | 承認済みの方針どおり、PC の Chrome/Edge で代替検証し、README に「Android 実機では未検証」と明記する |
| Supabase の空き枠が0 | 既存プロジェクトは削除・流用しない。5.1 節の代替案を提示して判断を待つ |
| 通知 API の悪用 | 4.1 節（JWT・CRON_SECRET・本人の端末のみ・回数制限・固定文面） |
| iOS で通知許可を一度拒否 | 再追加手順を案内。試作時は慎重に許可する |
| 標準 SMTP の送信制限 | ログイン頻度を下げる（セッション保持）。足りなければ無料の SMTP（例：Resend 無料枠）を検討（その時点で相談） |
| Next.js の静的出力の不具合 | バージョン固定＋Linux ビルド＋ check スクリプト |
| pg_cron のみでは一時停止を防げない可能性 | README に再開手順。日常利用で回避 |

---

## 12. 作業上のルール
- 作業場所は `C:\Users\iotot\dev\routine-lab` に限定（一時ファイルは Claude のスクラッチ領域）。課題①などほかのフォルダ・既存アプリ・既存 Supabase プロジェクトは変更しない。
- 通常の実装・テスト・軽微な修正は確認なしでまとめて進め、各 Phase の終わりにテスト結果と動作確認を報告する。
- **直前に承認が必要な操作**：Supabase（プロジェクト作成、`db push`、Auth 設定、secrets・Vault、Function deploy、cron 登録）、GitHub（リポジトリ作成、push、設定変更）、Cloudflare（Pages 作成、環境変数、公開）。まとめて頼まず、操作ごとに内容を示して承認を得る。
- 有料サービス・有料プランは使わない。
- 要件変更が必要になった場合（通知方式の変更、構成の変更など）は、実装前に相談する。
- `docs/requirements.md` は変更しない。計画の写しは承認後に `docs/plan.md` として保存する。
