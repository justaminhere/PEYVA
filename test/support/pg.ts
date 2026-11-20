/**
 * TEST-ONLY real PostgreSQL: one embedded server per test process (temp dir, random port), and a fresh migrated
 * database per test file. If PEYVA_TEST_DATABASE_ADMIN_URL is set (e.g. a Docker Postgres), that server is used instead.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, migrateDb, type DbHandle } from "../../src/db/client.ts";
import { startEmbedded } from "../../src/db/embedded.ts";
import postgres from "postgres";

type Server = { adminUrl: (db: string) => string; stop: () => Promise<void>; dir: string; port: number };
let server: Promise<Server> | null = null;

export function pgServer(): Promise<Server> {
  server ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "peyva-pg-"));
    const port = 40000 + Math.floor(Math.random() * 20000);
    const s = await startEmbedded({ dir, port, quiet: true });
    process.on("beforeExit", () => void s.stop());
    return { ...s, dir, port };
  })();
  return server;
}

export async function freshDb(): Promise<DbHandle & { url: string; name: string }> {
  const s = await pgServer();
  const name = `t_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = postgres(s.adminUrl("postgres"), { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const url = s.adminUrl(name);
  const h = connect(url, { max: 4 });
  await migrateDb(h.db);
  return { ...h, url, name };
}
