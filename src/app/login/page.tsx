"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { missingPublicEnv } from "@/lib/env";
import { safeNextPath } from "@/lib/nav";
import { ConfigError } from "@/components/AuthGate";

// S-01 ログイン：メールアドレス → 6桁コード（F-001）。
// マジックリンクは使わない（iPhone のホーム画面アプリと Safari は保存領域が別のため。要件 8.4 節）。

export default function LoginPage() {
  return (
    <Suspense fallback={<p className="p-6 text-muted">読み込み中…</p>}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (missingPublicEnv().length > 0) return <ConfigError />;

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const { error } = await getSupabase().auth.signInWithOtp({
      email: email.trim(),
      // 利用者は登録済みの本人だけ。ログイン画面から新しいユーザーを作らない
      // （未登録のアドレスでも同じ文面のエラーにして、登録の有無を推測させない）
      options: { shouldCreateUser: false },
    });
    setBusy(false);
    if (error) {
      setMessage(
        error.status === 429
          ? "送信回数の上限に達しました。しばらく待ってから試してください。"
          : "コードを送れませんでした。メールアドレスを確認してください。",
      );
      return;
    }
    setStep("code");
    setMessage("メールに届いた6桁のコードを入力してください。");
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const { error } = await getSupabase().auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    setBusy(false);
    if (error) {
      setMessage("コードが正しくないか、有効期限が切れています。");
      return;
    }
    router.replace(safeNextPath(params.get("next")));
  }

  return (
    <main className="mx-auto w-full max-w-sm px-4 py-10">
      <h1 className="text-2xl font-bold">Routine Lab</h1>
      <p className="mt-1 text-muted">メールアドレスでログイン</p>

      {step === "email" ? (
        <form onSubmit={sendCode} className="mt-6 space-y-4">
          <label className="block">
            <span className="text-sm font-bold">メールアドレス</span>
            <input
              type="email"
              required
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block min-h-11 w-full rounded-md border border-border bg-surface px-3"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="min-h-11 w-full rounded-md bg-accent font-bold text-accent-foreground disabled:opacity-60"
          >
            {busy ? "送信中…" : "コードを送る"}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="mt-6 space-y-4">
          <label className="block">
            <span className="text-sm font-bold">6桁のコード</span>
            <input
              type="text"
              required
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="mt-1 block min-h-11 w-full rounded-md border border-border bg-surface px-3 text-center text-xl tracking-[0.4em]"
            />
          </label>
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="min-h-11 w-full rounded-md bg-accent font-bold text-accent-foreground disabled:opacity-60"
          >
            {busy ? "確認中…" : "ログイン"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("email");
              setCode("");
              setMessage(null);
            }}
            className="min-h-11 w-full rounded-md border border-border"
          >
            メールアドレスを入力し直す
          </button>
        </form>
      )}

      {message && (
        <p className="mt-4 text-sm" role="status">
          {message}
        </p>
      )}
    </main>
  );
}
