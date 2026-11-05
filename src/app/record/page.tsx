"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";

// S-03 記録（Phase 0 では、通知のタップでこの画面が開くことの確認用）。
// ID はクエリ文字列で受け取る（静的出力のため動的ルートを使わない。要件 7.2 節）。

export default function RecordPage() {
  return (
    <AppShell title="記録">
      <AuthGate>
        {() => (
          <Suspense fallback={<p className="text-muted">読み込み中…</p>}>
            <RecordBody />
          </Suspense>
        )}
      </AuthGate>
    </AppShell>
  );
}

function RecordBody() {
  const params = useSearchParams();
  const occurrenceId = params.get("o");
  return (
    <section className="space-y-3">
      <p className="rounded-lg border border-border bg-surface p-4">
        通知から記録画面を開きました。
        <br />
        <span className="text-sm text-muted">予定ID：</span>
        <code className="break-all text-sm">{occurrenceId ?? "（指定なし）"}</code>
      </p>
      <p className="text-sm text-muted">
        完了・延期・見送りの記録は Phase 1 で実装します。
      </p>
    </section>
  );
}
