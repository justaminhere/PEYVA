import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect, ensureUser, type DbHandle } from "../src/db/client.ts";
import { PreferenceStore } from "../src/memory/preferences.ts";
import { GoalService, constraintsHash } from "../src/goals/service.ts";
import { ExecutorRegistry } from "../src/goals/types.ts";
import { constraintsFromTripGoal, makeTravelPriceExecutor, type TravelPriceConstraints } from "../src/goals/travel.ts";
import { applyPatch, emptyGoal } from "../src/goal/state.ts";
import { GoalPatchSchema } from "../src/goal/schema.ts";
import { RecordedProvider } from "./support/recorded-provider.ts";
import { freshDb } from "./support/pg.ts";

const now = new Date("2026-11-20T10:00:00Z");
let h: DbHandle & { url: string };
beforeAll(async () => { h = await freshDb(); await ensureUser(h.db, "amin"); await ensureUser(h.db, "other"); });
afterAll(() => h.close());

const registry = () => new ExecutorRegistry().register(makeTravelPriceExecutor(new RecordedProvider(() => now)));
const base: TravelPriceConstraints = {
  origin: { cityId: "tehran", fa: "تهران", iata: "THR" }, destination: { cityId: "kish", fa: "کیش", iata: "KIH" },
  dates: { mode: "fixed", departure: "2026-12-10", return: "2026-12-13" }, nights: 3, adults: 1, children: 0, rooms: 1,
  minimumHotelStars: null, budgetToman: 30_000_000,
};

// ---------- memory ----------

test("preferences: only confirm() writes; values validated; sensitive/unknown keys refused; survives reconnect", async () => {
  const p = new PreferenceStore(h.db);
  expect((await p.list("amin"))).toEqual([]); // a proposal that was never confirmed does not exist here
  expect(await p.confirm("amin", "min_hotel_stars", 4, null, now)).toMatchObject({ ok: true });
  expect(await p.confirm("amin", "home_city", "تهران", null, now)).toMatchObject({ ok: true });
  expect(await p.confirm("amin", "min_hotel_stars", 9, null, now)).toMatchObject({ ok: false });
  expect(await p.confirm("amin", "religion", "x", null, now)).toMatchObject({ ok: false });
  expect(await p.confirm("amin", "home_city", "پاریس", null, now)).toMatchObject({ ok: false });
  const again = connect(h.url, { max: 1 }); // a new process would see the same rows
  expect((await new PreferenceStore(again.db).list("amin")).map((x) => [x.key, x.value])).toEqual([["home_city", "تهران"], ["min_hotel_stars", 4]]);
  await again.close();
});

test("preferences: edit, delete, and no cross-user access", async () => {
  const p = new PreferenceStore(h.db);
  await p.set("amin", "min_hotel_stars", 5);
  expect((await p.list("amin")).find((x) => x.key === "min_hotel_stars")?.value).toBe(5);
  expect(await p.list("other")).toEqual([]);
  expect(await p.delete("other", "min_hotel_stars")).toBe(false); // cannot delete someone else's
  expect(await p.delete("amin", "min_hotel_stars")).toBe(true);
  expect((await p.list("amin")).map((x) => x.key)).toEqual(["home_city"]);
});

// ---------- goal lifecycle ----------

test("draft -> active needs approval of exactly the shown conditions; the result is persisted", async () => {
  const s = new GoalService(h.db, registry());
  const d = await s.createDraft("amin", "travel_price", base, now);
  if (!d.ok) throw new Error(d.reason);
  expect(d.goal.status).toBe("draft");
  expect(d.summaryFa).toContain("۳۰٬۰۰۰٬۰۰۰ تومان");
  expect(await s.approve("amin", d.goal.id, "wrong-hash", now)).toMatchObject({ ok: false, reason: "stale_approval" });
  expect(await s.approve("other", d.goal.id, d.goal.constraintsHash, now)).toMatchObject({ ok: false, reason: "not_found" });
  const a = await s.approve("amin", d.goal.id, d.goal.constraintsHash, now);
  expect(a).toMatchObject({ ok: true, goal: { status: "active", approvedConstraintsHash: d.goal.constraintsHash } });
  const again = connect(h.url, { max: 1 });
  expect(await new GoalService(again.db, registry()).get("amin", d.goal.id)).toMatchObject({ status: "active" });
  await again.close();
});

test("pause / resume / cancel follow the persisted state; a canceled goal cannot be resumed", async () => {
  const s = new GoalService(h.db, registry());
  const d = await s.createDraft("amin", "travel_price", base, now);
  if (!d.ok) throw new Error();
  await s.approve("amin", d.goal.id, d.goal.constraintsHash, now);
  expect(await s.pause("amin", d.goal.id, now)).toMatchObject({ ok: true, goal: { status: "paused" } });
  expect(await s.pause("amin", d.goal.id, now)).toMatchObject({ ok: false, reason: "wrong_state" });
  expect(await s.resume("amin", d.goal.id, now)).toMatchObject({ ok: true, goal: { status: "active" } });
  expect(await s.cancel("other", d.goal.id, now)).toMatchObject({ ok: false, reason: "not_found" });
  expect(await s.cancel("amin", d.goal.id, now)).toMatchObject({ ok: true, goal: { status: "canceled" } });
  expect(await s.resume("amin", d.goal.id, now)).toMatchObject({ ok: false });
});

test("a change to an approved goal is only a proposal: the approved conditions keep running until the user approves it", async () => {
  const s = new GoalService(h.db, registry());
  const d = await s.createDraft("amin", "travel_price", base, now);
  if (!d.ok) throw new Error();
  const act = await s.approve("amin", d.goal.id, d.goal.constraintsHash, now);
  if (!act.ok) throw new Error();
  const same = await s.updateConstraints("amin", d.goal.id, base, now);
  expect(same).toMatchObject({ ok: true, changed: false, proposal: false, goal: { status: "active" } });
  const later = new Date(now.getTime() + 60_000);
  const e = await s.updateConstraints("amin", d.goal.id, { ...base, budgetToman: 20_000_000 }, later);
  if (!e.ok) throw new Error();
  expect(e).toMatchObject({ changed: true, proposal: true, goal: { status: "active", constraintsHash: d.goal.constraintsHash, approvedConstraintsHash: d.goal.constraintsHash, proposedHash: e.hash } });
  expect((e.goal.structuredConstraints as { budgetToman: number }).budgetToman).toBe(30_000_000); // still the approved budget
  expect(e.goal.nextCheckAt).toEqual(act.goal.nextCheckAt); // schedule untouched
  expect(e.summaryFa).toContain("۲۰٬۰۰۰٬۰۰۰");
  expect(await s.approve("amin", d.goal.id, d.goal.constraintsHash, later)).toMatchObject({ ok: false, reason: "stale_approval" }); // the old hash approves nothing
  const ok = await s.approve("amin", d.goal.id, e.hash, later);
  expect(ok).toMatchObject({ ok: true, goal: { status: "active", constraintsHash: e.hash, approvedConstraintsHash: e.hash, proposedHash: null, proposedConstraints: null } });
  if (!ok.ok) throw new Error();
  expect((ok.goal.structuredConstraints as { budgetToman: number }).budgetToman).toBe(20_000_000);
  expect(ok.goal.nextCheckAt).toEqual(later); // the new conditions are checked soon
  expect(constraintsHash({ b: 1, a: 2 })).toBe(constraintsHash({ a: 2, b: 1 }));
});

test("rejecting a proposed change keeps the approved goal, status and schedule exactly as they were", async () => {
  const s = new GoalService(h.db, registry());
  const d = await s.createDraft("amin", "travel_price", base, now);
  if (!d.ok) throw new Error();
  const act = await s.approve("amin", d.goal.id, d.goal.constraintsHash, now);
  if (!act.ok) throw new Error();
  const e = await s.updateConstraints("amin", d.goal.id, { ...base, budgetToman: 18_000_000 }, now);
  if (!e.ok) throw new Error();
  expect(await s.rejectChange("amin", d.goal.id, "wrong-hash", now)).toMatchObject({ ok: false, reason: "stale_approval" });
  expect(await s.rejectChange("other", d.goal.id, e.hash, now)).toMatchObject({ ok: false, reason: "not_found" });
  const r = await s.rejectChange("amin", d.goal.id, e.hash, now);
  expect(r).toMatchObject({ ok: true, goal: { status: "active", constraintsHash: d.goal.constraintsHash, approvedConstraintsHash: d.goal.constraintsHash, proposedHash: null } });
  if (!r.ok) throw new Error();
  expect(r.goal.nextCheckAt).toEqual(act.goal.nextCheckAt);
  expect((r.goal.structuredConstraints as { budgetToman: number }).budgetToman).toBe(30_000_000);
  // paused goals: an approved change keeps them paused; drafts are edited in place and stay drafts
  await s.pause("amin", d.goal.id, now);
  const e2 = await s.updateConstraints("amin", d.goal.id, { ...base, budgetToman: 22_000_000 }, now);
  if (!e2.ok) throw new Error();
  expect(await s.approve("amin", d.goal.id, e2.hash, now)).toMatchObject({ ok: true, goal: { status: "paused", proposedHash: null } });
  const d2 = await s.createDraft("amin", "travel_price", base, now);
  if (!d2.ok) throw new Error();
  const e3 = await s.updateConstraints("amin", d2.goal.id, { ...base, budgetToman: 25_000_000 }, now);
  expect(e3).toMatchObject({ ok: true, proposal: false, goal: { status: "draft", proposedHash: null } });
  // cancel drops a waiting proposal too
  const e4 = await s.updateConstraints("amin", d.goal.id, { ...base, budgetToman: 21_000_000 }, now);
  if (!e4.ok) throw new Error();
  expect(await s.cancel("amin", d.goal.id, now)).toMatchObject({ ok: true, goal: { status: "canceled", proposedHash: null } });
});

test("expired goals stop; drafts for past dates are refused", async () => {
  const s = new GoalService(h.db, registry());
  const d = await s.createDraft("amin", "travel_price", base, now);
  if (!d.ok) throw new Error();
  await s.approve("amin", d.goal.id, d.goal.constraintsHash, now);
  const later = new Date("2026-12-11T00:00:00Z");
  expect(await s.expireDue(later)).toBeGreaterThan(0);
  expect(await s.get("amin", d.goal.id)).toMatchObject({ status: "expired", nextCheckAt: null });
  expect(await s.createDraft("amin", "travel_price", base, later)).toMatchObject({ ok: false, reason: "expired" });
  expect(await s.createDraft("amin", "travel_price", { ...base, budgetToman: 5 }, now)).toMatchObject({ ok: false, reason: "invalid_constraints" });
});

// ---------- the spec's request -> constraints ----------

test("'بهمن سه شب کیش، تهران، دو نفر، چهارستاره، زیر ۱۵ میلیون': rooms must be asked; Bahman year confirmed; correct Gregorian window", () => {
  const p = GoalPatchSchema.parse({ intent: "trip", origin: "تهران", destination: "کیش", month: { text: "بهمن" }, nights: 3, adults: 2,
    minimumHotelStars: 4, budgetText: "زیر ۱۵ میلیون تومان", monitoringRequested: true });
  let g = applyPatch(emptyGoal(), p, now);
  expect(constraintsFromTripGoal(g)).toMatchObject({ ok: false, missing: ["rooms", "confirm assumptions"] });
  g = applyPatch(g, { rooms: 1, confirmAssumptions: true }, now);
  const c = constraintsFromTripGoal(g);
  if (!c.ok) throw new Error(c.missing.join());
  expect(c.constraints).toMatchObject({ dates: { mode: "window", from: "2027-01-21", to: "2027-02-19" }, adults: 2, rooms: 1, minimumHotelStars: 4, budgetToman: 15_000_000 });
});

// ---------- executor: deterministic classification ----------

const exec = (p = new RecordedProvider(() => now)) => makeTravelPriceExecutor(p);

test("MATCH_FOUND with the exact deterministic total (real recorded MrBilit data)", async () => {
  const r = await exec().run(base, { now });
  expect(r.status).toBe("MATCH_FOUND");
  expect(r.match).toMatchObject({ totalToman: 25_114_300, provider: "mrbilit" });
  expect(r.match!.key).toBe("2026-12-10|21956337|21956366|10977");
  expect(r.summary).toMatchObject({ searches: 3 });
});

test("NO_MATCH when complete data is over budget; stars are a hard constraint", async () => {
  expect((await exec().run({ ...base, budgetToman: 15_000_000 }, { now })).status).toBe("NO_MATCH");
  const four = await exec().run({ ...base, minimumHotelStars: 4 }, { now });
  expect(four.match?.totalToman).toBe(28_681_300);
  expect((four.match!.details as any).hotel.stars).toBeGreaterThanOrEqual(4);
});

test("2 adults in 1 room: only rooms that sleep 2 are eligible", async () => {
  const r = await exec().run({ ...base, adults: 2 }, { now });
  expect(r.status).toBe("MATCH_FOUND");
  expect((r.match!.details as any).hotel.id).toBe("10977"); // Paniz sleeps 2 in the recording
});

test("a provider error is PROVIDER_ERROR, never NO_MATCH, and further searches stop", async () => {
  const p = new RecordedProvider(() => now, {}, new Set(["F:THR-KIH-2026-12-10"]));
  const r = await exec(p).run(base, { now });
  expect(r.status).toBe("PROVIDER_ERROR");
  expect(r.errorReason).toContain("network_or_geo_block");
  expect(p.calls).toEqual(["F:THR-KIH-2026-12-10"]);
});

test("empty provider results are INCOMPLETE_DATA, not an error and not a match", async () => {
  const r = await exec().run({ ...base, origin: { cityId: "mashhad", fa: "مشهد", iata: "MHD" } }, { now });
  expect(r.status).toBe("INCOMPLETE_DATA");
  expect(r.errorReason).toBeNull();
});

test("a window searches a bounded set of dates (max 3 candidates, max 9 searches)", async () => {
  const p = new RecordedProvider(() => now);
  const r = await exec(p).run({ ...base, dates: { mode: "window", from: "2027-01-21", to: "2027-02-19" } }, { now });
  expect(p.calls.length).toBe(9);
  expect((r.summary as any).candidates.length).toBe(3);
});

test("past dates mark the goal as expired instead of searching", async () => {
  const p = new RecordedProvider(() => now);
  const r = await exec(p).run(base, { now: new Date("2026-12-20T00:00:00Z") });
  expect(r).toMatchObject({ expired: true, status: "INCOMPLETE_DATA" });
  expect(p.calls).toEqual([]);
});
