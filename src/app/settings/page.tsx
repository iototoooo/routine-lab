"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { getSupabase } from "@/lib/supabase/client";
import {
  currentEndpoint,
  detectPushEnvironment,
  disablePushOnThisDevice,
  enablePush,
  requestTestPush,
} from "@/lib/push/client";
import { describeDevice, pushReadiness, type PushEnvironment } from "@/lib/push/platform";

// S-10 設定（Phase 0：通知の許可・端末の一覧・テスト送信・ログアウト）

type Device = {
  id: string;
  endpoint: string;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
  disabled_at: string | null;
};

const btn =
  "min-h-11 w-full rounded-md px-4 font-bold disabled:opacity-60";
const primary = `${btn} bg-accent text-accent-foreground`;
const secondary = `${btn} border border-border bg-surface`;

function formatJst(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

export default function SettingsPage() {
  return (
    <AppShell title="設定">
      <AuthGate>{() => <SettingsBody />}</AuthGate>
    </AppShell>
  );
}

function SettingsBody() {
  const router = useRouter();
  const [env, setEnv] = useState<PushEnvironment | null>(null);
  const [permission, setPermission] = useState<string>("—");
  const [devices, setDevices] = useState<Device[]>([]);
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const e = detectPushEnvironment();
    setEnv(e);
    setPermission(e.hasNotification ? Notification.permission : "非対応");
    setThisEndpoint(await currentEndpoint());
    const { data } = await getSupabase()
      .from("push_subscriptions")
      .select("id, endpoint, user_agent, created_at, last_success_at, disabled_at")
      .order("created_at", { ascending: false });
    setDevices((data as Device[] | null) ?? []);
  }, []);

  useEffect(() => {
    // 画面を開いたときに一度だけ、端末の状態と登録済み端末を読み込む
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "エラーが発生しました。");
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  const readiness = env ? pushReadiness(env) : null;
  const subscribedHere = thisEndpoint !== null &&
    devices.some((d) => d.endpoint === thisEndpoint && !d.disabled_at);

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
        <h2 className="font-bold">通知</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">この端末</dt>
          <dd>{env ? (env.isIOS ? "iPhone / iPad" : "その他") : "—"}</dd>
          <dt className="text-muted">ホーム画面から起動</dt>
          <dd>{env ? (env.isStandalone ? "はい" : "いいえ") : "—"}</dd>
          <dt className="text-muted">通知の許可</dt>
          <dd>{permission}</dd>
          <dt className="text-muted">この端末の登録</dt>
          <dd>{subscribedHere ? "登録済み" : "未登録"}</dd>
        </dl>

        {readiness?.kind === "ios-needs-home-screen" && <IosGuide />}
        {readiness?.kind === "unsupported" && (
          <p className="text-sm text-danger">このブラウザは Web Push に対応していません。</p>
        )}
        {permission === "denied" && <DeniedGuide isIOS={env?.isIOS ?? false} />}

        {readiness?.kind === "ready" && (
          <div className="space-y-2">
            {!subscribedHere ? (
              <button
                className={primary}
                disabled={busy}
                // iOS ではユーザー操作の中で許可を求める必要がある（要件 8.1 節）
                onClick={() => run(async () => {
                  await enablePush();
                  return "この端末を登録しました。";
                })}
              >
                通知を許可してこの端末を登録
              </button>
            ) : (
              <>
                <button
                  className={primary}
                  disabled={busy}
                  onClick={() => run(async () => (await requestTestPush("now")).message)}
                >
                  テスト通知を今すぐ送る
                </button>
                <button
                  className={secondary}
                  disabled={busy}
                  onClick={() => run(async () => (await requestTestPush("delayed", 60)).message)}
                >
                  1分後にテスト通知（送ったらアプリを閉じる）
                </button>
                <button
                  className={secondary}
                  disabled={busy}
                  onClick={() => run(async () => {
                    await disablePushOnThisDevice();
                    return "この端末の通知を解除しました。";
                  })}
                >
                  この端末の通知を解除
                </button>
              </>
            )}
          </div>
        )}
        <p className="text-xs text-muted">
          テスト通知は、ログイン中の本人の端末にだけ届きます。1分に1回・1日10回までです。
          通知にはルーティン名が表示されます。ロック画面に表示したくない場合は、
          端末の設定で「プレビューを表示」を「ロックされていないときのみ」にしてください。
        </p>
        {message && <p className="text-sm" role="status">{message}</p>}
      </section>

      <section className="space-y-2 rounded-lg border border-border bg-surface p-4">
        <h2 className="font-bold">登録済みの端末</h2>
        {devices.length === 0 ? (
          <p className="text-sm text-muted">まだありません。</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {devices.map((d) => (
              <li key={d.id} className="py-2">
                <p className="font-bold">
                  {describeDevice(d.user_agent)}
                  {d.endpoint === thisEndpoint && "（この端末）"}
                  {d.disabled_at && <span className="ml-2 text-muted">無効</span>}
                </p>
                <p className="text-muted">
                  登録：{formatJst(d.created_at)} ／ 最終送信成功：{formatJst(d.last_success_at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <button
          className={secondary}
          disabled={busy}
          onClick={async () => {
            await getSupabase().auth.signOut();
            router.replace("/login/");
          }}
        >
          ログアウト
        </button>
      </section>
    </div>
  );
}

function IosGuide() {
  return (
    <div className="rounded-md border border-border p-3 text-sm">
      <p className="font-bold">iPhone では、ホーム画面に追加すると通知を使えます</p>
      <ol className="mt-1 list-decimal space-y-1 pl-5">
        <li>Safari の画面下にある共有ボタン（四角から矢印）を押す</li>
        <li>「ホーム画面に追加」を選ぶ</li>
        <li>ホーム画面の「Routine Lab」から開き、もう一度この画面で通知を許可する</li>
      </ol>
      <p className="mt-1 text-muted">iOS / iPadOS 16.4 以降が必要です。</p>
    </div>
  );
}

function DeniedGuide({ isIOS }: { isIOS: boolean }) {
  return (
    <div className="rounded-md border border-danger p-3 text-sm">
      <p className="font-bold text-danger">通知が拒否されています</p>
      {isIOS ? (
        <p className="mt-1">
          iPhone では、ホーム画面の Routine Lab を削除して追加し直すと、もう一度許可を求められます。
          または「設定」アプリ →「通知」→「Routine Lab」で許可してください。
        </p>
      ) : (
        <p className="mt-1">ブラウザのサイト設定から、このサイトの通知を「許可」にしてください。</p>
      )}
    </div>
  );
}
