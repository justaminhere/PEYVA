import { expect, test } from "bun:test";
import { GoalPatchSchema } from "../src/goal/schema.ts";
import { analyze, applyPatch, emptyGoal } from "../src/goal/state.ts";

const now = new Date("2026-11-20T10:00:00Z");
const step = (g: ReturnType<typeof emptyGoal>, p: unknown) => applyPatch(g, GoalPatchSchema.parse(p), now);

test("the spec's three-turn conversation merges without forgetting", () => {
  let g = step(emptyGoal(), { intent: "trip", destination: "کیش", nights: 3 });
  let a = analyze(g, now);
  expect(a.missing).toEqual(["origin", "dates", "adults"]);

  g = step(g, { origin: "تهران", adults: 2, budgetText: "۲۰ میلیون" });
  a = analyze(g, now);
  expect(a.missing).toEqual(["dates", "rooms"]);
  expect(g.destination?.iata).toBe("KIH");
  expect(g.dates.nights).toBe(3);
  expect(g.budget).toMatchObject({ toman: 20_000_000, assumedUnit: true, scope: "unspecified" });

  g = step(g, { dateWindow: { from: { calendar: "jalali", month: 10, day: 10 }, to: { calendar: "jalali", month: 10, day: 20 } }, datesFlexible: true, rooms: 1 });
  a = analyze(g, now);
  expect(a.missing).toEqual([]);
  expect(a.ready).toBe(false); // the year of "10 Dey" was assumed: must be confirmed first
  expect(a.pendingAssumptions[0]).toContain("۱۴۰۵");

  g = step(g, { confirmAssumptions: true });
  a = analyze(g, now);
  expect(a.ready).toBe(true);
  expect(g.dates.window).toEqual({ from: "2026-12-31", to: "2027-01-10" });
  expect(a.plan).toEqual([
    { departure: "2026-12-31", return: "2027-01-03", nights: 3 },
    { departure: "2027-01-03", return: "2027-01-06", nights: 3 },
    { departure: "2027-01-07", return: "2027-01-10", nights: 3 },
  ]);
  expect(a.planNote).toContain("3 departure dates");
  expect(a.disclosures).toContain("budget unit not stated: interpreted as Toman");
});

test("nothing is invented: no defaults for origin, dates, travellers or budget", () => {
  const g = step(emptyGoal(), { intent: "trip", destination: "کیش" });
  expect(g.origin).toBeNull();
  expect(g.adults).toBeNull();
  expect(g.rooms).toBeNull();
  expect(g.budget).toBeNull();
  expect(g.dates.departure).toBeNull();
});

test("'date does not matter' does not create a date range", () => {
  const g = step(emptyGoal(), { intent: "trip", destination: "کیش", datesFlexible: true });
  const a = analyze(g, now);
  expect(g.dates.window).toBeNull();
  expect(a.missing).toContain("dates");
  expect(a.disclosures.join()).toContain("rough month");
});

test("one traveller derives one room; two travellers must say", () => {
  let g = step(emptyGoal(), { adults: 1 });
  expect(g).toMatchObject({ rooms: 1, roomsDerived: true });
  g = step(g, { adults: 2 });
  expect(g).toMatchObject({ rooms: null, roomsDerived: false });
});

test("contradictions and invalid input are reported, not searched", () => {
  const base = { intent: "trip", origin: "تهران", destination: "کیش", adults: 1 } as const;
  const past = analyze(step(emptyGoal(), { ...base, departureDate: { calendar: "gregorian", year: 2026, month: 11, day: 1 }, nights: 2 }), now);
  expect(past.conflicts.join()).toContain("past");
  const order = analyze(step(emptyGoal(), { ...base, departureDate: { calendar: "jalali", year: 1405, month: 9, day: 22 }, returnDate: { calendar: "jalali", year: 1405, month: 9, day: 19 } }), now);
  expect(order.conflicts.join()).toContain("not after");
  const nights = analyze(step(emptyGoal(), { ...base, departureDate: { calendar: "jalali", year: 1405, month: 9, day: 19 }, returnDate: { calendar: "jalali", year: 1405, month: 9, day: 22 }, nights: 5 }), now);
  expect(nights.conflicts.join()).toContain("3 nights but 5");
  const same = analyze(step(emptyGoal(), { ...base, destination: "Tehran" }), now);
  expect(same.conflicts).toContain("origin and destination are the same city");
  const city = analyze(step(emptyGoal(), { ...base, destination: "پاریس" }), now);
  expect(city.conflicts.join()).toContain("not a city PEYVA can search");
  const leap = step(emptyGoal(), { departureDate: { calendar: "jalali", year: 1405, month: 12, day: 30 } });
  expect(analyze(leap, now).conflicts.join()).toContain("does not exist");
  const rial = analyze(step(emptyGoal(), { budgetText: "۲۰ هزار" }), now);
  expect(rial.conflicts.join()).toContain("too small");
});

test("Rial budgets are converted to Toman", () => {
  const g = step(emptyGoal(), { budgetText: "۲۰۰ میلیون ریال" });
  expect(g.budget).toMatchObject({ toman: 20_000_000, assumedUnit: false });
});

test("the patch schema rejects invented fields and bad shapes (LLM output is validated)", () => {
  expect(GoalPatchSchema.safeParse({ destination: "کیش", price: 5 }).success).toBe(false);
  expect(GoalPatchSchema.safeParse({ adults: 0 }).success).toBe(false);
  expect(GoalPatchSchema.safeParse({ departureDate: { calendar: "jalali", month: 13, day: 1 } }).success).toBe(false);
  expect(GoalPatchSchema.safeParse({ minimumHotelStars: 4, monitoringRequested: true }).success).toBe(true);
});

test("monitoring intent is preserved across turns", () => {
  let g = step(emptyGoal(), { monitoringRequested: true });
  g = step(g, { destination: "کیش" });
  expect(g.monitoringRequested).toBe(true);
});
