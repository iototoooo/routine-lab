"use client";

import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";

// S-02 今日（Phase 0 では仮の画面。予定の一覧は Phase 1 で作る）
export default function TodayPage() {
  return (
    <AppShell title="今日">
      <AuthGate>
        {(session) => (
          <section className="space-y-4">
            <p className="text-muted">{session.user.email} でログイン中</p>
            <div className="rounded-lg border border-border bg-surface p-4">
              <p className="font-bold">通知の試作（Phase 0）</p>
              <p className="mt-1 text-sm text-muted">
                設定画面で通知を許可し、テスト通知を送って確認します。
              </p>
              <Link
                href="/settings/"
                className="mt-3 inline-flex min-h-11 items-center rounded-md bg-accent px-4 font-bold text-accent-foreground"
              >
                設定を開く
              </Link>
            </div>
          </section>
        )}
      </AuthGate>
    </AppShell>
  );
}
