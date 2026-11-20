import { expect, test } from "bun:test";
import { isFresh, todayInTehran, validateFlightQuery, validateHotelQuery } from "../../src/travel/provider.ts";
import { stayRatio } from "../../src/travel/checks.ts";
import { nightsBetween, normalizeFlights, normalizeHotels } from "../../src/normalize.ts";
import type { NormalizedHotel } from "../../src/types.ts";

const now = new Date("2026-11-20T21:00:00Z"); // 00:30 on 2026-11-21 in Tehran
const at = now.toISOString();

test("past dates are judged in Tehran local time", () => {
  expect(todayInTehran(now)).toBe("2026-11-21");
  expect(validateFlightQuery({ origin: "THR", destination: "KIH", date: "2026-11-20", adults: 1 }, now).join()).toContain("past");
  expect(validateFlightQuery({ origin: "THR", destination: "KIH", date: "2026-11-21", adults: 1 }, now)).toEqual([]);
});

test("flight query validation", () => {
  expect(validateFlightQuery({ origin: "THR", destination: "THR", date: "2026-02-30", adults: 0 }, now)).toHaveLength(3);
});

test("hotel query validation: order, length, real dates", () => {
  const q = { city: "کیش", checkIn: "2026-12-10", checkOut: "2026-12-13", adults: 1 };
  expect(validateHotelQuery(q, now)).toEqual([]);
  expect(validateHotelQuery({ ...q, checkOut: "2026-12-10" }, now).join()).toContain("after");
  expect(validateHotelQuery({ ...q, checkOut: "2027-02-10" }, now).join()).toContain("exceeds");
  expect(validateHotelQuery({ ...q, checkIn: "2026-12-32" }, now).join()).toContain("real");
});

test("normalizeHotels refuses a zero-night stay instead of dividing by zero", () => {
  expect(nightsBetween("2026-12-10", "2026-12-10")).toBe(0);
  expect(() => normalizeHotels("mrbilit", { hotels: [] }, "2026-12-10", "2026-12-10", at)).toThrow(RangeError);
});

test("freshness: older than 15 min is not current", () => {
  expect(isFresh("2026-11-20T20:50:00Z", now)).toBe(true);
  expect(isFresh("2026-11-20T20:40:00Z", now)).toBe(false);
  expect(isFresh("2026-11-20T21:05:00Z", now)).toBe(false); // from the future: not trusted
  expect(isFresh("garbage", now)).toBe(false);
});

test("MrBilit round-trip package (2 directions) is flagged, destination not taken from the return leg", () => {
  const seg = (from: string, to: string) => ({ from, to, departure: "x", arrival: "y", stops: 0, flights: ["XX 1"], airline: "A" });
  const r = normalizeFlights("mrbilit", { flights: [{ flight_id: "P", price_toman: 5, total_toman: 5, segments: [seg("THR", "IST"), seg("IST", "THR")] }] }, at);
  expect(r.rows[0]).toMatchObject({ origin: "THR", destination: "IST", stops: 0, dataStatus: "partial" });
  expect(r.rows[0]!.issues.join()).toContain("round-trip package");
});

test("cheapest room that does not fit the party is flagged", () => {
  const r = normalizeHotels("mrbilit", { nights: 3, hotels: [{ id: 1, name: "S", price_toman: 9, per_night_toman: 3, cheapest_room_sleeps: 1 }] },
    "2026-12-10", "2026-12-13", at, 2);
  expect(r.rows[0]!.roomSleeps).toBe(1);
  expect(r.rows[0]!.issues.join()).toContain("sleeps 1 < 2");
});

test("stay ratio detects a per-night price mislabelled as whole stay", () => {
  const h = (id: string, totalPrice: number) => ({ providerHotelId: id, totalPrice }) as NormalizedHotel;
  expect(stayRatio([h("a", 300), h("b", 600)], [h("a", 100), h("b", 210)])).toMatchObject({ pairs: 2, suspicious: 0 });
  expect(stayRatio([h("a", 100)], [h("a", 100)]).suspicious).toBe(1);
});
