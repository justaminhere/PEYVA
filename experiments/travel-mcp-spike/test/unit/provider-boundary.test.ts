/** TravelSearchProvider contract, against the TEST-ONLY fake server (synthetic data, no network). */
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { McpTravelProvider } from "../../src/travel/mcp-provider.ts";
import { PROVIDERS } from "../../src/providers.ts";

const fakeConfig = { ...PROVIDERS.mrbilit, command: process.execPath, args: ["run", join(import.meta.dir, "..", "support", "fake-server.ts")] };
const now = () => new Date("2026-11-20T10:00:00Z");
const calls: string[] = [];
const p = new McpTravelProvider(fakeConfig, { skipPreflight: true, now, onCall: (t) => { calls.push(t.tool); } });
afterAll(() => p.close());

test("healthCheck reports tools present", async () => {
  const h = await p.healthCheck();
  expect(h.ok).toBe(true);
  expect(h.checks.map((c) => c.name)).toEqual(["mcp tools"]);
});

test("ok: rows normalized, provider + timestamp preserved, no URL invented", async () => {
  const r = await p.searchFlights({ origin: "THR", destination: "KIH", date: "2026-12-10", adults: 1 });
  expect(r.status).toBe("ok");
  expect(r.items.length).toBe(2);
  expect(r.items.every((f) => f.provider === "mrbilit" && f.checkedAt === r.checkedAt && f.sourceUrl === null)).toBe(true);
  expect(r.totalAvailable).toBe(2);
  expect(r.truncated).toBe(false);
});

test("empty is distinct from error", async () => {
  const r = await p.searchFlights({ origin: "THR", destination: "MHD", date: "2026-12-10", adults: 1 });
  expect(r.status).toBe("empty");
  expect(r.error).toBeNull();
  expect(r.notes.join()).toContain("No flights");
});

test("provider failure is status=error with a cause, not a throw", async () => {
  const r = await p.searchFlights({ origin: "THR", destination: "AWZ", date: "2026-12-10", adults: 1 });
  expect(r.status).toBe("error");
  expect(r.error?.cause).toBe("network_or_geo_block");
  expect(r.items).toEqual([]);
});

test("invalid queries are rejected before any provider call", async () => {
  const before = calls.length;
  const r = await p.searchFlights({ origin: "thr", destination: "KIH", date: "2026-12-10", adults: 1 });
  const h = await p.searchHotels({ city: "کیش", checkIn: "2026-12-13", checkOut: "2026-12-10", adults: 1 });
  expect(r.error?.cause).toBe("invalid_query");
  expect(h.error?.cause).toBe("invalid_query");
  expect(calls.length).toBe(before);
});

test("hotels: city resolved by the provider once, truncation visible, whole-stay basis", async () => {
  const before = calls.length;
  const a = await p.searchHotels({ city: "کیش", checkIn: "2026-12-10", checkOut: "2026-12-13", adults: 1 });
  const b = await p.searchHotels({ city: "کیش", checkIn: "2026-12-10", checkOut: "2026-12-13", adults: 1 });
  expect(calls.slice(before)).toEqual(["mb_find_place", "mb_search_hotels", "mb_search_hotels"]);
  expect(a.status).toBe("ok");
  expect(a.totalAvailable).toBe(5);
  expect(a.truncated).toBe(true);
  expect(a.items.every((h) => h.priceBasis === "whole_stay_one_room" && h.nights === 3)).toBe(true);
  expect(b.status).toBe("ok");
});

test("unknown hotel city is an invalid_query error, not an empty result", async () => {
  const r = await p.searchHotels({ city: "ناکجا", checkIn: "2026-12-10", checkOut: "2026-12-13", adults: 1 });
  expect(r.status).toBe("error");
  expect(r.error?.cause).toBe("invalid_query");
});
