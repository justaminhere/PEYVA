/** Spend control survives restarts: per-visitor and site counters live in PostgreSQL, with a monthly cap and a kill switch. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { DbHandle } from "../src/db/client.ts";
import { usageCounters } from "../src/db/schema.ts";
import { DEFAULT_QUOTAS, Quotas, quotasFromEnv, type QuotaOptions } from "../src/web/public.ts";
import { PgUsageStore, type UsageStore } from "../src/web/usage-store.ts";
import { freshDb } from "./support/pg.ts";

let h: DbHandle & { url: string };
beforeAll(async () => { h = await freshDb(); });
afterAll(() => h.close());
beforeEach(async () => { await h.db.delete(usageCounters); });

let clock = new Date("2026-11-20T10:00:00Z");
const now = () => clock;
beforeEach(() => { clock = new Date("2026-11-20T10:00:00Z"); });
const opts = (o: Partial<QuotaOptions> = {}): QuotaOptions => ({ ...DEFAULT_QUOTAS, turnsPerVisitorPerDay: 2, tokensPerDay: 1_000, tokensPerMonth: 2_500, ...o });
/** A "server start": a new Quotas object over the same database. */
const made: Quotas[] = [];
const boot = async (o: Partial<QuotaOptions> = {}) => { const q = await Quotas.create(opts(o), new PgUsageStore(h.db), now); made.push(q); return q; };
// Writes are asynchronous: let every instance finish before the next test clears the table.
afterEach(async () => { await Promise.all(made.splice(0).map((q) => q.flush())); });

function turn(q: Quotas, user: string, tokens = 0) {
  const t = q.beginTurn(user);
  if (t.ok) t.done(tokens);
  return t;
}

test("a visitor's daily turns survive a restart", async () => {
  const a = await boot();
  expect(turn(a, "v1").ok).toBe(true);
  expect(turn(a, "v1").ok).toBe(true);
  await a.flush();

  const b = await boot(); // restart
  const refused = turn(b, "v1");
  expect(refused.ok).toBe(false);
  expect(turn(b, "v2").ok).toBe(true); // others are unaffected
});

test("the site's daily token total survives a restart", async () => {
  const a = await boot();
  turn(a, "v1", 900);
  await a.flush();
  const b = await boot();
  expect(b.tokensUsedToday()).toBe(900);
  turn(b, "v2", 200); // 1,100 now: over the daily cap
  expect(turn(b, "v3").ok).toBe(false);
});

test("a new UTC day resets the daily counts but not the monthly total", async () => {
  const a = await boot();
  turn(a, "v1", 900);
  turn(a, "v2", 900);
  await a.flush();
  clock = new Date("2026-11-21T00:00:05Z");
  const b = await boot();
  expect(b.tokensUsedToday()).toBe(0);
  expect(turn(b, "v3", 800).ok).toBe(true); // month total is now 2,600: over the 2,500 cap
  const refused = turn(b, "v4");
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.errorFa).toContain("ماه");
});

test("the monthly cap resets with the next month", async () => {
  const a = await boot({ tokensPerMonth: 500 });
  turn(a, "v1", 600);
  await a.flush();
  expect(turn(a, "v2").ok).toBe(false);
  clock = new Date("2026-12-01T00:00:05Z");
  const b = await boot({ tokensPerMonth: 500 });
  expect(turn(b, "v2").ok).toBe(true);
});

test("the kill switch refuses every LLM turn but leaves manual searches alone", async () => {
  const q = await boot({ killSwitch: true });
  const t = q.beginTurn("v1");
  expect(t.ok).toBe(false);
  if (!t.ok) expect(t.status).toBe(503);
  expect(q.beginSearch("v1").ok).toBe(true);
});

test("quotasFromEnv reads the monthly cap and the kill switch", () => {
  expect(quotasFromEnv({}).killSwitch).toBe(false);
  expect(quotasFromEnv({ PEYVA_KILL_SWITCH: "1" }).killSwitch).toBe(true);
  expect(quotasFromEnv({ PEYVA_PUBLIC_TOKENS_PER_MONTH: "123" }).tokensPerMonth).toBe(123);
});

test("fails closed: when the database cannot record usage, LLM turns are refused", async () => {
  const broken: UsageStore = { load: async () => new Map(), add: async () => { throw new Error("db down"); } };
  const q = await Quotas.create(opts(), broken, now);
  expect(turn(q, "v1").ok).toBe(true); // this one is allowed, and its write fails
  await q.flush();
  const t = q.beginTurn("v1");
  expect(t.ok).toBe(false);
  expect(q.beginSearch("v1").ok).toBe(true); // no LLM cost: still allowed
});

test("fails closed at start: if usage cannot be loaded, creating the quotas throws", async () => {
  const broken: UsageStore = { load: async () => { throw new Error("db down"); }, add: async () => {} };
  await expect(Quotas.create(opts(), broken, now)).rejects.toThrow();
});

test("IP addresses are not written to the database", async () => {
  const q = await boot();
  expect(q.allowNewVisitor("203.0.113.7")).toBe(true);
  turn(q, "v1", 10);
  await q.flush();
  const rows = await h.db.select().from(usageCounters);
  expect(rows.length).toBeGreaterThan(0);
  expect(JSON.stringify(rows)).not.toContain("203.0.113.7");
});
