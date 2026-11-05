"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// 画面下のタブ（今日・ルーティン・分析・設定）。Phase 0 では今日と設定だけが動く。
const TABS = [
  { href: "/", label: "今日" },
  { href: "/routines/", label: "ルーティン" },
  { href: "/analytics/", label: "分析" },
  { href: "/settings/", label: "設定" },
] as const;

export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 pb-3 pt-[max(env(safe-area-inset-top),0.75rem)] backdrop-blur">
        <h1 className="text-lg font-bold">{title}</h1>
      </header>
      <main className="flex-1 px-4 py-4 pb-24">{children}</main>
      <nav
        aria-label="メインメニュー"
        className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="mx-auto grid max-w-xl grid-cols-4">
          {TABS.map((t) => {
            const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-14 items-center justify-center text-sm ${
                    active ? "font-bold text-accent" : "text-muted"
                  }`}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
