// DB / RLS テストの土台（docs/phase1-plan.md 5章）。
// 本番の Supabase には一切つながず、手元の PGlite（WASM で動く PostgreSQL）に
// supabase/migrations/*.sql をすべて順に適用して確かめる。
//
// Supabase にしかない部分は、テストに必要な最小限の代役を用意する：
//   - ロール anon / authenticated / service_role と、public スキーマの既定の権限
//     （Supabase は新しい表・関数を anon / authenticated に自動で公開する。マイグレーションの revoke が効いているかを確かめるため、同じ既定を再現する）
//   - auth.users と auth.uid()（request.jwt.claims の sub を読む。PostgREST と同じ）
//   - vault.decrypted_secrets、net.http_post（呼び出しを記録するだけ。外には出ない）、cron.schedule（登録内容を記録するだけ）
// pg_cron / pg_net の create extension は PGlite に無いので、適用前に取り除く。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

export const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text, aud text, role text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text);
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;

create schema net;
create table net.calls (id bigserial primary key, url text, headers jsonb, body jsonb);
create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
returns bigint language sql as $$
  insert into net.calls (url, headers, body) values (url, headers, body) returning id
$$;

create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
create function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d)
$$;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key);
`;

/** PGlite に無い拡張機能の行だけを取り除く（それ以外はそのまま適用する） */
export function prepareMigration(sql: string): string {
  return sql
    .replace(/^\s*create extension if not exists pg_cron\s*;\s*$/gim, "-- (test) pg_cron は代役を使う")
    .replace(/^\s*create extension if not exists pg_net\b[^;]*;\s*$/gim, "-- (test) pg_net は代役を使う");
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

export async function createTestDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { btree_gist } });
  await db.exec(SUPABASE_STUB);
  for (const f of migrationFiles()) {
    try {
      await db.exec(prepareMigration(readFileSync(join(MIGRATIONS_DIR, f), "utf8")));
    } catch (e) {
      throw new Error(`マイグレーション ${f} の適用に失敗: ${e instanceof Error ? e.message : e}`);
    }
  }
  return db;
}

let seq = 0;
/** テスト用ユーザーを作る（profiles はトリガーで自動作成される） */
export async function createUser(db: PGlite, label = "user"): Promise<string> {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${label}${seq}@example.test`]);
  return id;
}

type Role = "anon" | "authenticated" | "service_role";

/** 指定したロール・ユーザーになりきって、1つのトランザクションの中で実行する（PostgREST と同じやり方） */
export async function as<T>(
  db: PGlite,
  role: Role,
  userId: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(userId ? { sub: userId, role } : { role }),
    ]);
    return fn(tx);
  });
}

/** 失敗するはずの処理の、エラーメッセージ（失敗しなければ null） */
export async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** JST の日時の文字列から timestamptz の文字列を作る（例：jst("2026-11-10 07:00")） */
export function jst(dateTime: string): string {
  return `${dateTime}+09`;
}
