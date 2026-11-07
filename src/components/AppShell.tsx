"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// 画面下のタブ。分析タブは Phase 3 で追加する（まだ無い画面へのリンクを置かない）。
const TABS = [
  { href: "/", label: "今日" },
  { href: "/routines/", label: "ルーティン" },
  { href: "/settings/", label: "設定" },
] as const;

export function AppShell({
  title,
  children,
  back,
}: {
  title: string;
  children: ReactNode;
  back?: { href: string; label: string };
}) {
  const pathname = usePathname();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-4 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)] backdrop-blur">
        {back && (
          <Link href={back.href} className="-ml-2 inline-flex min-h-11 min-w-11 items-center px-2 text-accent">
            ‹ {back.label}
          </Link>
        )}
        <h1 className="py-2 text-lg font-bold">{title}</h1>
      </header>
      <main className="flex-1 px-4 py-4 pb-24">{children}</main>
      <nav
        aria-label="メインメニュー"
        className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="mx-auto grid max-w-xl grid-cols-3">
          {TABS.map((t) => {
            const active = t.href === "/" ? pathname === "/" || pathname.startsWith("/record") : pathname.startsWith(t.href);
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
