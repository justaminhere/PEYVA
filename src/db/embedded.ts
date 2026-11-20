/**
 * A real PostgreSQL server from the `embedded-postgres` npm package (official PostgreSQL binaries), for local
 * development and tests without Docker. Any other Postgres works too: just set PEYVA_DATABASE_URL.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";

export interface EmbeddedOptions { dir: string; port: number; user?: string; password?: string; database?: string; quiet?: boolean }

export async function startEmbedded(o: EmbeddedOptions) {
  const user = o.user ?? "peyva", password = o.password ?? "peyva", database = o.database ?? "peyva";
  const pg = new EmbeddedPostgres({
    databaseDir: o.dir, port: o.port, user, password, persistent: true,
    onLog: o.quiet ? () => {} : undefined, onError: o.quiet ? () => {} : undefined,
    // Rebuild the package's symlinks at runtime instead of running its blocked postinstall script.
    autoRehydrateSymlinks: true,
  } as ConstructorParameters<typeof EmbeddedPostgres>[0]);
  if (!existsSync(join(o.dir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  const admin = postgres(`postgres://${user}:${password}@localhost:${o.port}/postgres`, { max: 1, onnotice: () => {} });
  const found = await admin`select 1 from pg_database where datname = ${database}`;
  if (!found.length) await admin.unsafe(`create database "${database.replace(/"/g, "")}"`);
  await admin.end();
  return {
    url: `postgres://${user}:${password}@localhost:${o.port}/${database}`,
    adminUrl: (db: string) => `postgres://${user}:${password}@localhost:${o.port}/${db}`,
    stop: () => pg.stop(),
  };
}
