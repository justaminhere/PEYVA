/** Database connection and migrations. The URL comes from PEYVA_DATABASE_URL; it is never logged with its password. */
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export interface DbHandle { db: Db; sql: postgres.Sql; close: () => Promise<void> }

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "drizzle");

export function connect(url: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(url, { max: opts.max ?? 5, onnotice: () => {}, connection: { TimeZone: "UTC" } });
  return { db: drizzle(sql, { schema }), sql, close: () => sql.end({ timeout: 5 }) };
}

export async function migrateDb(db: Db) {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

export function databaseUrlFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  return env.PEYVA_DATABASE_URL?.trim() || null;
}

export function redactUrl(url: string): string {
  try { const u = new URL(url); if (u.password) u.password = "***"; return u.toString(); } catch { return "(invalid url)"; }
}

export async function ensureUser(db: Db, id: string) {
  await db.insert(schema.users).values({ id }).onConflictDoNothing();
}
