# テスト記録（実機・ブラウザ）

docs/plan.md 9章・9.1 節の実機テストの結果を記録する。

## Phase 0：通知の試作

### PC（Windows・Microsoft Edge、localhost）— 2026-11-05
| # | 確認内容 | 結果 | 照合（DB、読み取り専用） |
| --- | --- | --- | --- |
| 1 | 6桁メール OTP でログイン（Resend の SMTP 経由） | OK | `auth.users` 1件、`profiles` 1件（自動作成） |
| 2 | 設定画面のボタンで通知を許可し、端末を登録 | OK | `push_subscriptions` 有効1件（送信先 `*.notify.windows.com`＝WNS）。持ち主はログインしたユーザー |
| 3 | テスト通知（今すぐ）を受信 | OK | `notification_deliveries` 3件、すべて HTTP 201 |
| 4 | 通知のクリックで記録画面（`/record/?o=test-…`）が開く | OK | — |
| 5 | 1分以内の再送信は回数制限で拒否（429）、通知は届かない | OK | `push_test_log` 3件（約1分間隔）。拒否した依頼は記録・送信されていない |
| — | cron・Vault は未設定のまま | — | `notification_jobs` 0件、`net._http_response` 0件、Vault 0件 |

- Edge の Web Push は Microsoft の WNS を使う。Android と同じ FCM 経路の代替確認は、**PC の Chrome** で別途行う。
- 未確認（この時点）：遅延送信（cron 経由）、アプリを閉じた状態での受信、iPhone 実機 → 下の 2026-11-06〜07 の記録で確認済み。

### 本番 URL（Cloudflare Pages）の配信 — 2026-11-06
| 確認内容 | 結果 |
| --- | --- |
| `https://routine-lab.pages.dev/` の `/`・`/login/`・`/settings/`・`/record/` | すべて 200 |
| `/sw.js`・`/manifest.webmanifest` | 200、Content-Type が正しく、`Cache-Control: no-cache`（`public/_headers` が効いている） |
| アイコン（192・512・maskable・apple-touch-icon） | すべて 200 |
| 公開値の埋め込み | Supabase URL と VAPID 公開鍵がビルドに入っている。配信中の JS に秘密の値はない |
| Edge Function の CORS（`ALLOWED_ORIGINS` 更新後） | 本番 URL と localhost は許可、それ以外（`https://evil.example`、プレビュー URL）は許可しない |

### iPhone 実機（iOS 18.7・ホーム画面に追加した PWA、本番 URL）
| # | 確認内容（plan.md 9.1 節の対応番号） | 日時（JST） | 結果 | 照合（DB、読み取り専用） |
| --- | --- | --- | --- | --- |
| 1 | Safari で開き「ホーム画面に追加」（9.1-1） | 11/06 | OK | — |
| 2 | ホーム画面のアプリで 6桁コードのログイン | 11/06 | OK | — |
| 3 | 設定画面のボタンで通知を許可し、端末を登録（9.1-2） | 11/06 13:22 | OK | `push_subscriptions` に `web.push.apple.com` の有効な端末が1件 |
| 4 | テスト通知（今すぐ）を受信し、タップで記録画面が開く | 11/06 13:22 | OK | `notification_deliveries` HTTP 201（iPhone・PC の2台） |
| 5 | **予約通知（1分後）を、アプリを App スイッチャーから完全に終了し、画面をロックした状態で受信**（9.1-3・9.1-6） | 11/07 10:33 予約 | OK | 下の「予約通知の照合」 |
| 6 | 5 の通知をタップすると、アプリが起動して記録画面が開く（9.1-4） | 11/07 | OK | — |

**予約通知の照合（2026-11-07）**
| 段階 | 時刻（JST） | 記録 |
| --- | --- | --- |
| 予約（test-push、delayed 60 秒） | 10:33:37 | `push_test_log` 1件、`notification_jobs` 作成（期限 11:34:37） |
| 送信予定 | 10:34:37 | — |
| cron（毎分）→ pg_net → send-push | 10:35:00 | `net._http_response` HTTP 200、`{"jobs":1,"sent":1,"failed":0,"ms":1827}` |
| 端末への配送 | 10:35:02〜03 | PC（WNS）・iPhone（`web.push.apple.com`）とも HTTP 201 |
| ジョブの完了 | 10:35:03 | `status = sent`、試行1回、エラーなし |

- 予約から受信までは約1分半。cron は毎分0秒に動くため、最大で約2分遅れる（README の注意書きどおり）。
- 送信処理 1 回の所要時間は 1.8 秒（2台へ送信、DB の読み書きを含む実時間）。
- cron は設定後の約21時間で 1,260 回動いて失敗 0 回。send-push を呼んだのは、送るジョブがあった1回と設定直後の確認1回だけ（送るジョブがないときは呼ばない）。
- CRON_SECRET と Vault の設定前に作られた予約（11/06 13:24）は、設定時に `cancelled` にした。遅れて届いていない。

### 安全性の確認 — 2026-11-06（`npm run smoke:functions`、通知は送らない）
| 確認内容 | 結果 |
| --- | --- |
| test-push：ログインなし・偽のトークン・公開キーだけ | すべて 401 |
| test-push：許可していないオリジンからの CORS 事前確認 | `Access-Control-Allow-Origin` を返さない |
| send-push：合言葉なし・誤った合言葉 | 401（CRON_SECRET 設定後） |
| send-push：GET | 405 |
| 送信用の DB 関数 6 つを公開キーで呼ぶ | すべて 401（42501 permission denied） |
| テスト送信の回数制限（1分1回） | 429（PC で確認） |
| CRON_SECRET と Vault の合言葉 | SHA-256 の比較で一致（値は表示していない） |

### Phase 0 の判定：**Go**
plan.md 8章の Go 条件のうち、iPhone で「アプリを閉じた状態でも届く」「タップで記録画面が開く」を満たした。Edge Function の処理時間にも余裕がある（1回 1.8 秒、無料枠の上限は CPU 2 秒・実時間 150 秒で、CPU 時間はこれより短い）。

### 未検証の項目（後の Phase で確認する）
| 項目 | 予定 |
| --- | --- |
| 他人の端末に届かないこと（テスト用ユーザー2人） | Phase 1 の DB / RLS テストで2人目のユーザーを管理 API で作って確認 |
| 同じ予定への2回送信が1件に置き換わる（tag、9.1-8） | Phase 2（予定 ID を tag にする本番の通知で確認） |
| 延期した予定の再通知（9.1-5）、完了後に通知が届かない（9.1-7） | Phase 2 |
| PC の Chrome（Android と同じ FCM 経由）での受信・タップ遷移 | Phase 2 までに実施 |
| 購読解除後の 404 / 410 による端末の無効化 | Phase 2 |
| Android 実機 | 実機がないため未検証（PC の Chrome / Edge で代替） |
| iOS 16.4〜17 | 手元の iOS 18.7 だけで確認 |
| Edge Function の CPU 時間の厳密な計測 | 実時間（1.8 秒）のみ記録。Supabase のダッシュボードで必要に応じて確認 |

## Phase 1：土台とデータ保存

### 自動テスト（2026-11-07）
| 種類 | 件数 | 結果 |
| --- | --- | --- |
| 単体＋DB / RLS（Vitest、PGlite） | 113 | すべて成功 |
| ブラウザ（Playwright、Pixel 7 / iPhone 14 の表示） | 24 | すべて成功 |
| 本番 DB スモーク（`supabase/tests/phase1_smoke.sql`、全体を取り消し） | 13 項目 | `SMOKE_OK`。テストデータの残存なし |
| CI（GitHub Actions、commit dd8370c） | — | 成功。Cloudflare Pages の自動デプロイも成功 |

### iPhone 実機（iOS 18.7・ホーム画面の PWA、本番 URL）— 2026-11-07
| # | 確認内容 | 結果 |
| --- | --- | --- |
| 1 | ルーティンを新しく登録できる | 成功 |
| 2 | 登録したルーティンが一覧に出る | 成功 |
| 3 | 今日・明日の予定が正しく表示される | 成功 |
| 4 | 「予定どおり完了」で記録できる | 成功 |
| 5 | 延期の時刻と理由を保存できる | 成功 |
| 6 | 見送りと理由を記録できる | 成功 |
| 7 | 編集すると設定の変更履歴（版）が増える | 成功 |
| 8 | 詳細画面で予定時刻と実績を比べられる | 成功 |
| 9 | Phase 0 のテスト通知が引き続き届く | 成功 |

- 予定時刻の通知は届かない：Phase 1 では通知ジョブを作らない仕様（判断事項4）のため。Phase 2 で実装する。
- 調査の記録：テスト通知の確認中に「届かない」と見えた件は、送信記録で Apple の Push サービスが 201（受け付け）を返しており、通知の経路に問題はなかった。届かなかったのは予定時刻の通知（上記の仕様）だった。

### Phase 1 の判定：**完了**（2026-11-07）
完成条件 1〜4（ルーティンの登録・編集の版管理、予定の自動作成、記録と3種類の時刻、変更履歴）を本番で満たした。
