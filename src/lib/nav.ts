/** ログイン後の移動先。同じサイト内のパスだけを許す（外部サイトへの誘導を防ぐ） */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.startsWith("/login")) return "/";
  return next;
}
