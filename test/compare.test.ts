import { expect, test } from "bun:test";
import { allowedPrices, bestOverall, compareCandidate } from "../src/compare/engine.ts";
import { GoalPatchSchema } from "../src/goal/schema.ts";
import { analyze, applyPatch, emptyGoal } from "../src/goal/state.ts";
import { RecordedProvider } from "./support/recorded-provider.ts";

const now = new Date("2026-11-20T10:00:00Z");
const goalWith = (p: object) => applyPatch(emptyGoal(), GoalPatchSchema.parse({
  intent: "trip", origin: "تهران", destination: "کیش", adults: 1, nights: 3,
  departureDate: { calendar: "jalali", year: 1405, month: 9, day: 19 }, ...p,
}), now);
const cand = { departure: "2026-12-10", return: "2026-12-13", nights: 3 };

async function run(goal = goalWith({}), provider = new RecordedProvider(() => now), at = now) {
  const travellers = (goal.adults ?? 1) + goal.children;
  const o = goal.origin!.iata!, d = goal.destination!.iata!;
  const outbound = await provider.searchFlights({ origin: o, destination: d, date: cand.departure, adults: travellers });
  const ret = await provider.searchFlights({ origin: d, destination: o, date: cand.return, adults: travellers });
  const hotels = await provider.searchHotels({ city: "کیش", checkIn: cand.departure, checkOut: cand.return, adults: travellers });
  return compareCandidate({ goal, candidate: cand, outbound, return: ret, hotels, now: at });
}

test("package arithmetic on REAL recorded data matches the hand-checked total", async () => {
  const c = await run();
  expect(c.status).toBe("complete");
  const best = c.options[0]!;
  expect(best.outbound?.flightNumbers).toEqual(["ZV 4030"]);
  expect(best.return?.flightNumbers).toEqual(["ZV 4031"]);
  expect(best.hotel?.id).toBe("10977");
  expect(best.totalToman).toBe(10_594_200 + 10_794_100 + 3_726_000);
  expect(best.totalToman).toBe(25_114_300);
  expect(best.outbound?.checkedAt).toBe(now.toISOString());
  expect(best.outbound?.provider).toBe("mrbilit");
});

test("minimum stars is a hard constraint", async () => {
  const c = await run(goalWith({ minimumHotelStars: 4 }));
  expect(c.options.every((o) => (o.hotel?.stars ?? 0) >= 4)).toBe(true);
  expect(c.options[0]!.hotel?.id).toBe("5269"); // cheapest 4-star in the recording (Sadaf, 7,293,000)
  expect(c.excluded["hotel: below minimum stars"]).toBeGreaterThan(0);
});

test("room capacity: 2 adults in 1 room excludes rooms that sleep 1; 2 rooms double the hotel price", async () => {
  const twoOneRoom = await run(goalWith({ adults: 2, rooms: 1 }));
  expect(twoOneRoom.options.every((o) => (o.hotel?.roomSleeps ?? 0) >= 2)).toBe(true);
  const twoRooms = await run(goalWith({ adults: 2, rooms: 2 }));
  const h = twoRooms.options[0]!.hotel!;
  expect(h.totalToman).toBe(h.pricePerRoomToman * 2);
  expect(twoRooms.options[0]!.warnings.join()).toContain("2 identical rooms");
});

test("budget: options are marked within/over budget, never hidden silently", async () => {
  const tight = await run(goalWith({ budgetText: "۲۵ میلیون تومان" }));
  expect(tight.options.every((o) => o.withinBudget === false)).toBe(true);
  const ok = await run(goalWith({ budgetText: "۳۰ میلیون تومان" }));
  expect(ok.options[0]!.withinBudget).toBe(true);
});

test("a provider error makes the package incomplete, distinct from an empty result", async () => {
  const failing = new RecordedProvider(() => now, {}, new Set(["H:کیش-2026-12-10-2026-12-13"]));
  const err = await run(goalWith({}), failing);
  expect(err.status).toBe("incomplete");
  expect(err.reasons.join()).toContain("hotel: provider error (rate_limit)");
  const empty = await run(goalWith({ origin: "مشهد" }));
  expect(empty.reasons.join()).toContain("provider listed nothing");
  expect(empty.options).toEqual([]);
});

test("stale results are flagged and ranked after fresh ones", async () => {
  const old = new Date(now.getTime() - 20 * 60_000);
  const staleRun = await run(goalWith({}), new RecordedProvider(() => old), now);
  expect(staleRun.stale).toBe(true);
  expect(staleRun.sources.hotel?.fresh).toBe(false);
  const fresh = await run(goalWith({ budgetText: "۹۰ میلیون" }));
  const pick = bestOverall([staleRun, fresh]);
  expect(pick?.candidateIndex).toBe(1);
});

test("truncated provider lists are reported", async () => {
  const c = await run();
  expect(c.reasons.join()).toContain("hotel: provider returned 20 of 26 matches");
});

test("not-on-sale / unpriced and too-few-seat flights are excluded, unknown seats are allowed with a warning", async () => {
  const p = new RecordedProvider(() => now, {
    "F:THR-KIH-2026-12-10": (d: any) => { d.flights[0].price_toman = null; d.flights[1].seats_left = 0; d.flights[2].seats_left = null; return d; },
  });
  const c = await run(goalWith({}), p);
  expect(c.excluded["flight: no price / not listed"]).toBe(1);
  expect(c.excluded["flight: too few seats"]).toBe(1);
  expect(c.options[0]!.outbound?.flightNumbers).toEqual(["MEH 4152"]);
  expect(c.options[0]!.warnings).toContain("seat count not stated by the provider");
});

test("allowedPrices lists exactly the numbers a reply may cite", async () => {
  const c = await run();
  const s = allowedPrices([c]);
  expect(s.has(25_114_300)).toBe(true);
  expect(s.has(10_594_200)).toBe(true);
  expect(s.has(12_345_678)).toBe(false);
});

test("analysis plan + engine agree on nights", () => {
  const a = analyze(goalWith({}), now);
  expect(a.ready).toBe(true);
  expect(a.plan).toEqual([cand]);
});
