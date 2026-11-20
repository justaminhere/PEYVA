import { expect, test } from "bun:test";
import { join } from "node:path";
import { cheapest, nightsBetween, normalizeFlights, normalizeHotels } from "../../src/normalize.ts";
import { tomanToRial } from "../../src/types.ts";

// SYNTHETIC fixtures — see test/fixtures/synthetic/README.md
const fx = (n: string) => Bun.file(join(import.meta.dir, "..", "fixtures", "synthetic", n)).json();
const at = "2026-11-20T00:00:00.000Z";

test("nights are computed from dates, not trusted from the provider", () => {
  expect(nightsBetween("2026-12-10", "2026-12-13")).toBe(3);
  expect(nightsBetween("2026-03-20", "2026-03-23")).toBe(3); // Iran Nowruz/DST-safe (UTC arithmetic)
});

test("MrBilit flight shape -> normalized, Toman, per-adult, no invented URL", async () => {
  const r = normalizeFlights("mrbilit", await fx("synthetic-mrbilit-flights.json"), at);
  expect(r.rows).toHaveLength(2);
  const f = r.rows[0]!;
  expect(f).toMatchObject({ provider: "mrbilit", providerFlightId: "SYN-1", origin: "THR", destination: "KIH",
    price: 1111110, totalPrice: 1111110, currency: "TOMAN", priceBasis: "per_adult", seatsLeft: 4,
    sourceUrl: null, stops: 0, flightNumbers: ["XX 100"], dataStatus: "live_search" });
  expect(r.rows[1]!.seatsLeft).toBeNull(); // missing stays null
});

test("FlyToday flight shape -> normalized", async () => {
  const r = normalizeFlights("flytoday", await fx("synthetic-flytoday-flights.json"), at);
  expect(r.rows[0]).toMatchObject({ provider: "flytoday", providerFlightId: "SYNFSC", airline: "Synthetic Air",
    price: 1234560, currency: "TOMAN", sourceUrl: null });
});

test("hotel prices are whole-stay one-room; per-night is cross-checked", async () => {
  const m = normalizeHotels("mrbilit", await fx("synthetic-mrbilit-hotels.json"), "2026-12-10", "2026-12-13", at);
  expect(m.shapeIssues).toEqual([]);
  expect(m.rows[0]).toMatchObject({ totalPrice: 9000000, providerPerNight: 3000000, nights: 3, priceBasis: "whole_stay_one_room",
    ratingScale: "0-5", currency: "TOMAN" });
  expect(m.rows[1]!.rating).toBeNull();
  const f = normalizeHotels("flytoday", await fx("synthetic-flytoday-hotels.json"), "2026-12-10", "2026-12-13", at);
  expect(f.rows[0]).toMatchObject({ providerHotelId: "77", totalPrice: 6000000, rating: 8.1, ratingScale: null, roomsLeft: 2 });
});

test("an inconsistent per-night figure is flagged, not silently accepted", () => {
  const r = normalizeHotels("mrbilit", { nights: 3, hotels: [{ id: 9, name: "X", price_toman: 9000000, per_night_toman: 9000000 }] },
    "2026-12-10", "2026-12-13", at);
  expect(r.rows[0]!.dataStatus).toBe("partial");
  expect(r.rows[0]!.issues.join()).toContain("inconsistent");
});

test("wrong provider nights is a shape issue", () => {
  const r = normalizeHotels("flytoday", { nights: 2, hotels: [] }, "2026-12-10", "2026-12-13", at);
  expect(r.shapeIssues[0]).toContain("provider nights 2 != computed 3");
});

test("unexpected shapes are reported, never coerced into data", () => {
  expect(normalizeFlights("mrbilit", "oops", at).shapeIssues).toEqual(["response is not a JSON object"]);
  expect(normalizeFlights("flytoday", { outbound: [] }, at).shapeIssues).toEqual(["no `flights` array"]);
  const r = normalizeFlights("mrbilit", { flights: [{ flight_id: "Z" }] }, at);
  expect(r.rows[0]).toMatchObject({ price: null, availability: "unknown", dataStatus: "partial" });
});

test("cheapest is deterministic and ignores nulls; Toman/Rial conversion is explicit", () => {
  const rows = [{ id: "b", p: 5 }, { id: "a", p: 5 }, { id: "c", p: null }];
  expect(cheapest(rows, (r) => r.p, (r) => r.id)!.id).toBe("a");
  expect(cheapest([{ id: "x", p: null }], (r) => r.p, (r) => r.id)).toBeNull();
  expect(tomanToRial(1_000_000)).toBe(10_000_000);
});
