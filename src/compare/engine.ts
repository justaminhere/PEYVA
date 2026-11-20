/**
 * Deterministic trip comparison. Pure functions, integer Toman. The LLM never computes or edits these numbers.
 *
 * Inclusion rules (hard constraints):
 * - Only results whose search succeeded. An error leg makes the package incomplete, never "0".
 * - Flights: price known, `availability: "listed"`, matching route and date, seats not known to be too few.
 * - Hotels: price known, the exact nights of the candidate, stars >= minimum (unknown stars excluded when a
 *   minimum is set), and room capacity >= travellers when the provider states capacity.
 * - Stale results (older than the freshness limit) are kept apart and never labelled current.
 */
import { isFresh, type NormalizedFlight, type NormalizedHotel, type SearchResult } from "../travel/index.ts";
import type { SearchCandidate } from "../goal/state.ts";
import type { TripGoal } from "../goal/schema.ts";

export interface LegSource { provider: string; checkedAt: string; status: string; fresh: boolean; truncated: boolean; totalAvailable: number | null; count: number; error: string | null }

export interface FlightPick { id: string | null; flightNumbers: string[]; airline: string | null; departureTime: string | null; arrivalTime: string | null; totalToman: number; seatsLeft: number | null; provider: string; checkedAt: string }
export interface HotelPick { id: string | null; name: string | null; stars: number | null; rating: number | null; nights: number; rooms: number; pricePerRoomToman: number; totalToman: number; roomSleeps: number | null; refundable: boolean | null; provider: string; checkedAt: string }

export interface PackageOption {
  outbound: FlightPick | null;
  return: FlightPick | null;
  hotel: HotelPick | null;
  totalToman: number;
  withinBudget: boolean | null;
  warnings: string[];
}

export interface CandidateComparison {
  candidate: SearchCandidate;
  status: "complete" | "incomplete" | "no_match";
  /** Why the package could not be completed (provider error, empty leg, nothing matched constraints). */
  reasons: string[];
  options: PackageOption[];
  excluded: Record<string, number>;
  sources: { outbound: LegSource | null; return: LegSource | null; hotel: LegSource | null };
  stale: boolean;
}

export interface CompareInput {
  goal: TripGoal;
  candidate: SearchCandidate;
  outbound: SearchResult<NormalizedFlight> | null;
  return: SearchResult<NormalizedFlight> | null;
  hotels: SearchResult<NormalizedHotel> | null;
  now: Date;
  maxAgeMs?: number;
  maxOptions?: number;
}

function source<T>(r: SearchResult<T> | null, now: Date, maxAgeMs?: number): LegSource | null {
  if (!r) return null;
  return { provider: r.provider, checkedAt: r.checkedAt, status: r.status, fresh: isFresh(r.checkedAt, now, maxAgeMs), truncated: r.truncated,
    totalAvailable: r.totalAvailable, count: r.items.length, error: r.error ? `${r.error.cause}: ${r.error.message.slice(0, 200)}` : null };
}

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

export function eligibleFlights(r: SearchResult<NormalizedFlight>, from: string, to: string, date: string, travellers: number, excluded: Record<string, number>): FlightPick[] {
  const out: FlightPick[] = [];
  for (const f of r.items) {
    if (f.totalPrice === null || f.availability !== "listed") { bump(excluded, "flight: no price / not listed"); continue; }
    if (f.origin !== from || f.destination !== to) { bump(excluded, "flight: other route"); continue; }
    if (!f.departureTime?.startsWith(date)) { bump(excluded, "flight: other date"); continue; }
    if (f.seatsLeft !== null && f.seatsLeft < travellers) { bump(excluded, "flight: too few seats"); continue; }
    if (f.issues.length) { bump(excluded, "flight: data issues"); continue; }
    out.push({ id: f.providerFlightId, flightNumbers: f.flightNumbers, airline: f.airline, departureTime: f.departureTime, arrivalTime: f.arrivalTime,
      totalToman: f.totalPrice, seatsLeft: f.seatsLeft, provider: f.provider, checkedAt: f.checkedAt });
  }
  return out.sort((a, b) => a.totalToman - b.totalToman || (a.id ?? "").localeCompare(b.id ?? ""));
}

export function eligibleHotels(r: SearchResult<NormalizedHotel>, goal: TripGoal, c: SearchCandidate, excluded: Record<string, number>): HotelPick[] {
  const rooms = goal.rooms ?? 1;
  const travellers = (goal.adults ?? 1) + goal.children;
  const out: HotelPick[] = [];
  for (const h of r.items) {
    if (h.totalPrice === null || h.availability !== "listed") { bump(excluded, "hotel: no price"); continue; }
    if (h.nights !== c.nights || h.checkIn !== c.departure || h.checkOut !== c.return) { bump(excluded, "hotel: other dates"); continue; }
    if (goal.minimumHotelStars !== null && (h.stars === null || h.stars < goal.minimumHotelStars)) { bump(excluded, "hotel: below minimum stars"); continue; }
    if (h.roomSleeps !== null && h.roomSleeps * rooms < travellers) { bump(excluded, "hotel: rooms too small for the party"); continue; }
    if (h.issues.some((i) => !i.includes("sleeps"))) { bump(excluded, "hotel: data issues"); continue; }
    out.push({ id: h.providerHotelId, name: h.name, stars: h.stars, rating: h.rating, nights: h.nights, rooms,
      pricePerRoomToman: h.totalPrice, totalToman: h.totalPrice * rooms, roomSleeps: h.roomSleeps, refundable: h.refundable,
      provider: h.provider, checkedAt: h.checkedAt });
  }
  return out.sort((a, b) => a.totalToman - b.totalToman || (a.id ?? "").localeCompare(b.id ?? ""));
}

export function budgetLimit(goal: TripGoal): number | null {
  if (!goal.budget) return null;
  const travellers = (goal.adults ?? 1) + goal.children;
  return goal.budget.scope === "per_person" ? goal.budget.toman * travellers : goal.budget.toman;
}

export function compareCandidate(i: CompareInput): CandidateComparison {
  const { goal, candidate: c, now } = i;
  const excluded: Record<string, number> = {};
  const reasons: string[] = [];
  const needFlights = goal.intent !== "hotel_only";
  const needHotel = goal.intent !== "flight_only";
  const travellers = (goal.adults ?? 1) + goal.children;
  const sources = { outbound: source(i.outbound, now, i.maxAgeMs), return: source(i.return, now, i.maxAgeMs), hotel: source(i.hotels, now, i.maxAgeMs) };

  const leg = <T>(name: string, r: SearchResult<T> | null, needed: boolean): boolean => {
    if (!needed) return true;
    if (!r) { reasons.push(`${name}: not searched`); return false; }
    if (r.status === "error") { reasons.push(`${name}: provider error (${r.error?.cause})`); return false; }
    if (r.status === "empty") { reasons.push(`${name}: provider listed nothing`); return false; }
    return true;
  };
  const okOut = leg("outbound flight", i.outbound, needFlights);
  const okRet = leg("return flight", i.return, needFlights);
  const okHot = leg("hotel", i.hotels, needHotel);

  const from = goal.origin?.iata ?? "", to = goal.destination?.iata ?? "";
  const outs = needFlights && okOut ? eligibleFlights(i.outbound!, from, to, c.departure, travellers, excluded) : [];
  const rets = needFlights && okRet ? eligibleFlights(i.return!, to, from, c.return, travellers, excluded) : [];
  const hots = needHotel && okHot ? eligibleHotels(i.hotels!, goal, c, excluded) : [];
  if (needFlights && okOut && !outs.length) reasons.push("outbound flight: nothing matched the constraints");
  if (needFlights && okRet && !rets.length) reasons.push("return flight: nothing matched the constraints");
  if (needHotel && okHot && !hots.length) reasons.push("hotel: nothing matched the constraints");

  const complete = (!needFlights || (outs.length > 0 && rets.length > 0)) && (!needHotel || hots.length > 0);
  const stale = [sources.outbound, sources.return, sources.hotel].some((s) => s && !s.fresh);
  const limit = budgetLimit(goal);
  const options: PackageOption[] = [];
  if (complete) {
    // Cheapest outbound + cheapest return, combined with the cheapest few hotels (deterministic, no LLM).
    const out = needFlights ? outs[0]! : null, ret = needFlights ? rets[0]! : null;
    for (const h of needHotel ? hots.slice(0, i.maxOptions ?? 3) : [null]) {
      const total = (out?.totalToman ?? 0) + (ret?.totalToman ?? 0) + (h?.totalToman ?? 0);
      const warnings: string[] = [];
      if (h && h.rooms > 1) warnings.push(`price assumes ${h.rooms} identical rooms at this rate; availability of ${h.rooms} rooms is not confirmed`);
      if (h && h.roomSleeps === null) warnings.push("room capacity not stated by the provider");
      if (out?.seatsLeft === null || ret?.seatsLeft === null) warnings.push("seat count not stated by the provider");
      if (h && h.roomSleeps !== null && h.roomSleeps < travellers && h.rooms * h.roomSleeps >= travellers) warnings.push(`needs ${h.rooms} rooms`);
      options.push({ outbound: out, return: ret, hotel: h, totalToman: total, withinBudget: limit === null ? null : total <= limit, warnings });
    }
    options.sort((a, b) => Number(b.withinBudget ?? true) - Number(a.withinBudget ?? true) || a.totalToman - b.totalToman);
  }
  for (const [n, s] of [["outbound", sources.outbound], ["return", sources.return], ["hotel", sources.hotel]] as const)
    if (s?.truncated) reasons.push(`${n}: provider returned ${s.count} of ${s.totalAvailable} matches (list truncated)`);
  return {
    candidate: c,
    status: complete ? "complete" : options.length ? "incomplete" : reasons.some((r) => r.includes("error") || r.includes("not searched")) ? "incomplete" : "no_match",
    reasons, options, excluded, sources, stale,
  };
}

/** Overall best across candidates: fresh + complete + within budget first, then cheapest. */
export function bestOverall(cs: CandidateComparison[]): { candidateIndex: number; option: PackageOption } | null {
  let best: { candidateIndex: number; option: PackageOption } | null = null;
  const rank = (o: PackageOption, stale: boolean) => [stale ? 1 : 0, o.withinBudget === false ? 1 : 0, o.totalToman] as const;
  cs.forEach((c, idx) => {
    if (c.status !== "complete") return;
    for (const o of c.options) {
      if (!best) { best = { candidateIndex: idx, option: o }; continue; }
      const a = rank(o, c.stale), b = rank(best.option, cs[best.candidateIndex]!.stale);
      if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) best = { candidateIndex: idx, option: o };
    }
  });
  return best;
}

/** Every price a reply may legitimately mention (used by the price guard). */
export function allowedPrices(cs: CandidateComparison[]): Set<number> {
  const s = new Set<number>();
  for (const c of cs) for (const o of c.options) {
    s.add(o.totalToman);
    for (const x of [o.outbound?.totalToman, o.return?.totalToman, o.hotel?.totalToman, o.hotel?.pricePerRoomToman]) if (x) s.add(x);
  }
  return s;
}
