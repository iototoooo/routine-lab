// ブラウザに出してよい値だけを扱う（docs/plan.md 4.1 節）。
// service_role キーや VAPID 秘密鍵は、ここにも NEXT_PUBLIC_* にも絶対に置かない。
// NEXT_PUBLIC_* はビルド時に静的に埋め込まれるため、process.env.XXX の形で直接参照する。

export type PublicEnv = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  vapidPublicKey: string;
};

export function readPublicEnv(): PublicEnv {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
  };
}

export function missingPublicEnv(env: PublicEnv = readPublicEnv()): string[] {
  const missing: string[] = [];
  if (!env.supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!env.supabaseAnonKey) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!env.vapidPublicKey) missing.push("NEXT_PUBLIC_VAPID_PUBLIC_KEY");
  return missing;
}
