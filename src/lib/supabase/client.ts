import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readPublicEnv } from "@/lib/env";

// 画面からは公開キー（anon / publishable）だけで接続する。データの守りは RLS（P-06）。
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const { supabaseUrl, supabaseAnonKey } = readPublicEnv();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Supabase の接続設定がありません（NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY）",
    );
  }
  client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // OTP 方式なので、URL からセッションを読む必要はない（要件 8.4 節）
      detectSessionInUrl: false,
    },
  });
  return client;
}
