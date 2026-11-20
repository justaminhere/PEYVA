import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connect, ensureUser, migrateDb, redactUrl } from "../src/db/client.ts";
import { startEmbedded } from "../src/db/embedded.ts";
import { goals, users } from "../src/db/schema.ts";
import { freshDb } from "./support/pg.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("migrations create the schema and the active-needs-approval rule is enforced by the database", async () => {
  const h = await freshDb();
  await ensureUser(h.db, "local");
  const base = { userId: "local", type: "travel_price", name: "x", structuredConstraints: {}, constraintsHash: "h1", expiresAt: new Date(Date.now() + 86_400_000) };
  await expect(h.db.insert(goals).values({ ...base, status: "active" }).execute()).rejects.toThrow(); // no approval
  await expect(h.db.insert(goals).values({ ...base, status: "active", approvedConstraintsHash: "h0", approvedAt: new Date() }).execute()).rejects.toThrow(); // stale approval
  const [g] = await h.db.insert(goals).values({ ...base, status: "active", approvedConstraintsHash: "h1", approvedAt: new Date() }).returning();
  expect(g!.status).toBe("active");
  await expect(h.db.insert(goals).values({ ...base, status: "running" as any }).execute()).rejects.toThrow();
  await h.close();
});

test("data survives a real PostgreSQL restart (stop + start of the server process)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peyva-restart-"));
  const port = 40000 + Math.floor(Math.random() * 20000);
  let pg = await startEmbedded({ dir, port, quiet: true });
  let h = connect(pg.url, { max: 1 });
  await migrateDb(h.db);
  await ensureUser(h.db, "local");
  const [g] = await h.db.insert(goals).values({ userId: "local", type: "travel_price", name: "کیش", structuredConstraints: { a: 1 },
    constraintsHash: "h", approvedConstraintsHash: "h", approvedAt: new Date(), status: "active", expiresAt: new Date(Date.now() + 86_400_000) }).returning();
  await h.close();
  await pg.stop();

  pg = await startEmbedded({ dir, port, quiet: true });
  h = connect(pg.url, { max: 1 });
  await migrateDb(h.db); // idempotent
  const [again] = await h.db.select().from(goals).where(eq(goals.id, g!.id));
  expect(again).toMatchObject({ name: "کیش", status: "active", structuredConstraints: { a: 1 } });
  expect((await h.db.select().from(users)).map((u) => u.id)).toEqual(["local"]);
  await h.close();
  await pg.stop();
}, 60_000);

test("database URLs are shown without passwords", () => {
  expect(redactUrl("postgres://peyva:secret@localhost:5432/peyva")).toBe("postgres://peyva:***@localhost:5432/peyva");
});
