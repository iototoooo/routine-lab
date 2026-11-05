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
- 未確認：遅延送信（cron 経由）、アプリを閉じた状態での受信、iPhone 実機（Cloudflare Pages 公開後）。
