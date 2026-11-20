#!/usr/bin/env bun
/**
 *   bun run db:start     start a local PostgreSQL (embedded, data in ./.pgdata) and keep it running (Ctrl+C stops it)
 *   bun run db:migrate   apply migrations to PEYVA_DATABASE_URL
 */
import { join } from "node:path";
import { connect, databaseUrlFromEnv, migrateDb, redactUrl } from "../db/client.ts";
import { startEmbedded } from "../db/embedded.ts";

const cmd = process.argv[2];
if (cmd === "start") {
  const port = Number(process.env.PEYVA_EMBEDDED_PG_PORT ?? 54329);
  const pg = await startEmbedded({ dir: join(import.meta.dir, "..", "..", ".pgdata"), port, quiet: true });
  console.log(`PostgreSQL is running. Put this in .env:\nPEYVA_DATABASE_URL=${pg.url}\n(Ctrl+C to stop)`);
  const stop = async () => { await pg.stop(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  await new Promise(() => {});
} else if (cmd === "migrate") {
  const url = databaseUrlFromEnv();
  if (!url) { console.error("PEYVA_DATABASE_URL is not set (see .env.example)."); process.exit(2); }
  const h = connect(url, { max: 1 });
  await migrateDb(h.db);
  console.log(`migrations applied to ${redactUrl(url)}`);
  await h.close();
} else {
  console.log("usage: bun run src/cli/db.ts <start|migrate>");
  process.exit(64);
}
