# Routine Lab

曜日ごとのルーティンを登録し、**予定と実績の差**を記録・分析して、PDCA で自分に合ったルーティンへ改善していく Web アプリ（PWA）です。

> 現在は **Phase 0（Web Push 通知の技術検証）が完了**し、Phase 1（ルーティンと記録の土台）の準備中です。
> Phase 0 では、iPhone のホーム画面アプリを完全に終了した状態でも予約通知が届き、タップで記録画面が開くことを確認しました（[テスト記録](docs/test-report.md)）。

- 公開 URL：https://routine-lab.pages.dev/ （利用者は登録済みの本人だけ。新規登録はできません）

- 要件定義：[docs/requirements.md](docs/requirements.md)
- 実装計画：[docs/plan.md](docs/plan.md)

## 技術構成
| 分類 | 技術 |
| --- | --- |
| 画面 | Next.js 16（App Router、**静的エクスポート**）＋ React 19 ＋ TypeScript（strict）＋ Tailwind CSS 4 |
| 公開 | Cloudflare Pages（無料。GitHub 連携で Linux 上でビルド） |
| 認証・DB | Supabase（Auth：メールの6桁コード、Postgres、RLS） |
| 定期実行 | Supabase pg_cron ＋ pg_net |
| 通知の送信 | Supabase Edge Functions（Deno）。Web Push の暗号化（RFC 8291）と VAPID 署名（RFC 8292）を WebCrypto で実装 |
| PWA | Web App Manifest ＋ 自作の Service Worker（`public/sw.js`） |
| テスト | Vitest（単体）。DB / RLS、ブラウザ、実機のテストは docs/plan.md 9章 |

## 通知の対応条件
| 端末 | 条件 | 検証の状況 |
| --- | --- | --- |
| iPhone / iPad | iOS / iPadOS 16.4 以降。**Safari の「ホーム画面に追加」で追加したアプリからのみ**通知を使えます。許可はアプリ内のボタンから行います | **iPhone 実機（iOS 18.7）で確認済み**：アプリを終了・ロックした状態での予約通知の受信、タップで記録画面を開く（[テスト記録](docs/test-report.md)） |
| Android | Chrome などで使えます（ブラウザのままでも PWA でも） | **Android 実機では未検証**です。PC の Edge（WNS 経由）で確認済み。Android と同じ FCM 経由の PC Chrome での確認は Phase 2 までに行います |
| PC | Chrome・Edge・Firefox・Safari | 補助的な利用。Edge（Windows）で受信・タップ遷移・予約通知を確認済み（[テスト記録](docs/test-report.md)） |

- Web Push は配送が保証された仕組みではありません。通知は予定時刻から最大 1〜2 分ほど遅れることがあります。アプリを開けば、今日の予定と未記録の予定を必ず確認できます。
- 通知にはルーティン名が表示されます。ロック画面に表示したくない場合は、端末の通知設定で「プレビューを表示」を「ロックされていないときのみ」にしてください。
- iPhone で通知を一度「許可しない」にすると、再度の確認は出ません。「設定」アプリ →「通知」→「Routine Lab」で許可するか、ホーム画面のアイコンを削除して追加し直してください。

## 無料枠の制約
| サービス | 主な制約 | このアプリでの対策 |
| --- | --- | --- |
| Supabase Free | 1組織で同時に動かせるのは2プロジェクトまで。1週間使われないと一時停止。自動バックアップなし。標準のメール送信は数が少ない | 1プロジェクトで運用。毎分の送信処理は「送るジョブがあるときだけ」Edge Function を呼ぶ。止まったときはダッシュボードから再開 |
| Supabase Edge Functions | 月50万回 | 毎分無条件でも月約4.3万回。実際はジョブがあるときだけ呼ぶ |
| Cloudflare Pages | ビルド回数の月上限 | 個人利用の範囲 |

## 開発
```bash
npm install
cp .env.example .env.local   # 公開値だけを書く（秘密の値は書かない）
npm run dev                  # http://localhost:3000
npm run check                # 静的出力・秘密情報・Lint・型・単体テスト
npm run build                # out/ に静的出力（前後にチェックが自動で走る）
```

- 秘密の値（service_role キー、VAPID 秘密鍵、CRON_SECRET、DB パスワード）は、リポジトリにもビルド結果にも含めません。置き場所は [CLAUDE.md](CLAUDE.md) の「秘密情報」を参照してください。
- Windows でビルドした `out/` はアップロードしません。デプロイは Cloudflare Pages 側（Linux）でビルドします。
