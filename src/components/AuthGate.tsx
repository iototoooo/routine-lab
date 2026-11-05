"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase/client";
import { missingPublicEnv } from "@/lib/env";

// 画面側のログイン確認（F-002）。静的出力ではサーバー側で確認できないため、ここで移動させる。
// 本当の守りは RLS（P-06）。この部品は「見せない・移動させる」ためだけのもの。

type Props = { children: (session: Session) => ReactNode };

export function AuthGate({ children }: Props) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const configMissing = missingPublicEnv().length > 0;

  useEffect(() => {
    if (configMissing) return;
    const supabase = getSupabase();
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (!data.session) {
        const next = window.location.pathname + window.location.search;
        router.replace(`/login/?next=${encodeURIComponent(next)}`);
        return;
      }
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      if (!active) return;
      if (!s) router.replace("/login/");
      else setSession(s);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [router, configMissing]);

  if (configMissing) return <ConfigError />;
  if (!ready || !session) {
    return <p className="p-6 text-muted">読み込み中…</p>;
  }
  return <>{children(session)}</>;
}

export function ConfigError() {
  return (
    <div className="m-4 rounded-lg border border-danger p-4 text-danger" role="alert">
      <p className="font-bold">接続設定がありません</p>
      <p className="mt-1 text-sm">不足：{missingPublicEnv().join(", ")}</p>
      <p className="mt-1 text-sm">.env.example を参考に .env.local を作成してください。</p>
    </div>
  );
}
