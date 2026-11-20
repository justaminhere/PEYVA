/** Normalization against REAL recorded mrbilit-mcp 0.5.2 responses (see test/fixtures/recorded/README.md). */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { normalizeFlights, normalizeHotels } from "../../src/normalize.ts";

const rec = (n: string) => Bun.file(join(import.meta.dir, "..", "fixtures", "recorded", n)).json();

test("real outbound flights THR->KIH 2026-12-10", async () => {
  const f = await rec("mrbilit-flights-THR-KIH-2026-12-10.json");
  const r = normalizeFlights("mrbilit", f.response, f.checkedAt);
  expect(r.shapeIssues).toEqual([]);
  expect(r.rows).toHaveLength(5);
  expect(r.totalAvailable).toBe(5);
  expect(r.notOnSale).toBe(3);
  expect(r.rows.every((x) => x.dataStatus === "live_search" && x.currency === "TOMAN" && x.origin === "THR" && x.destination === "KIH")).toBe(true);
  expect(r.rows.every((x) => x.departureTime?.startsWith("2026-12-10") && x.checkedAt === f.checkedAt)).toBe(true);
  // Cross-checked by hand against mrbilit.com on 2026-11-20: Zagros 06:00, 10,594,200 Toman.
  expect(r.rows[0]).toMatchObject({ flightNumbers: ["ZV 4030"], price: 10594200, totalPrice: 10594200, seatsLeft: 9 });
});

test("real return flights KIH->THR 2026-12-13", async () => {
  const f = await rec("mrbilit-flights-KIH-THR-2026-12-13.json");
  const r = normalizeFlights("mrbilit", f.response, f.checkedAt);
  expect(r.rows).toHaveLength(6);
  expect(r.rows.every((x) => x.origin === "KIH" && x.destination === "THR" && x.issues.length === 0)).toBe(true);
});

test("real hotels kish 3 nights: whole stay, consistent per-night, truncation visible", async () => {
  const f = await rec("mrbilit-hotels-kish-2026-12-10_13.json");
  const r = normalizeHotels("mrbilit", f.response, "2026-12-10", "2026-12-13", f.checkedAt, 1);
  expect(r.shapeIssues).toEqual([]);
  expect(r.rows).toHaveLength(20);
  expect(r.totalAvailable).toBe(26);
  expect(r.rows.every((h) => h.nights === 3 && h.providerNights === 3 && h.priceBasis === "whole_stay_one_room")).toBe(true);
  expect(r.rows.every((h) => h.issues.length === 0)).toBe(true);
  expect(r.rows[0]).toMatchObject({ providerHotelId: "10977", totalPrice: 3726000, providerPerNight: 1242000, roomSleeps: 2, rating: null });
  // For a party of 3, rooms that sleep fewer are flagged rather than silently priced.
  const three = normalizeHotels("mrbilit", f.response, "2026-12-10", "2026-12-13", f.checkedAt, 3);
  expect(three.rows.some((h) => h.issues.some((i) => i.includes("sleeps")))).toBe(true);
});
