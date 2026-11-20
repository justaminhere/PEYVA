/** Deterministic goal merging, gap detection and bounded search planning. */
import { addDays, daysBetween, formatJalaliFa, resolveDay, resolveMonth, type Resolved } from "./dates.ts";
import { parseAmount, toToman } from "./persian.ts";
import { emptyGoal, type GoalPatch, type Place, type TripGoal } from "./schema.ts";
import { findCity } from "../travel/places.ts";
import { MAX_NIGHTS, todayInTehran } from "../travel/index.ts";

function place(input: string): Place {
  const c = findCity(input);
  return { input, cityId: c?.id ?? null, fa: c?.fa ?? null, iata: c?.iata ?? null, verified: c?.verified ?? false };
}

/** Merges one message's patch into the session goal. Earlier constraints survive unless the patch replaces them. */
export function applyPatch(prev: TripGoal, patch: GoalPatch, now: Date): TripGoal {
  const g: TripGoal = structuredClone(prev);
  g.invalid = [];
  const known = new Set([prev.dates.departure, prev.dates.return, prev.dates.window?.from, prev.dates.window?.to].filter(Boolean));
  const take = <T>(label: string, r: Resolved<T>): T | null => {
    if (r.error) g.invalid.push(`${label}: ${r.error}`);
    // Re-stating a date that is already in the goal (e.g. "19 Azar" after "19 Azar 1405") needs no new confirmation.
    const same = typeof r.value === "string" ? known.has(r.value) : r.value && typeof r.value === "object" && "from" in r.value ? known.has((r.value as { from: string }).from) : false;
    if (r.assumption && !same && !g.pendingAssumptions.includes(r.assumption)) g.pendingAssumptions.push(r.assumption);
    return r.value;
  };
  if (patch.confirmAssumptions) g.pendingAssumptions = [];
  if (patch.intent && patch.intent !== "unknown") g.intent = patch.intent;
  if (patch.origin) g.origin = place(patch.origin);
  if (patch.destination) g.destination = place(patch.destination);

  if (patch.departureDate) {
    const d = take("departure date", resolveDay(patch.departureDate, now));
    if (d) { g.dates.departure = d; g.dates.window = null; g.dates.mode = "fixed"; g.dates.anyDate = false; }
  }
  if (patch.returnDate) {
    const d = take("return date", resolveDay(patch.returnDate, now));
    if (d) g.dates.return = d;
  }
  if (patch.dateWindow) {
    const from = take("range start", resolveDay(patch.dateWindow.from, now));
    const to = take("range end", resolveDay(patch.dateWindow.to, now));
    if (from && to) { g.dates.window = { from, to }; g.dates.departure = null; g.dates.mode = "flexible"; g.dates.anyDate = false; }
  }
  if (patch.month) {
    const w = take("month", resolveMonth(patch.month, now));
    if (w) { g.dates.window = w; g.dates.departure = null; g.dates.mode = "flexible"; g.dates.anyDate = false; }
  }
  if (patch.datesFlexible) {
    if (g.dates.window || g.dates.departure) g.dates.mode = g.dates.window ? "flexible" : g.dates.mode;
    else g.dates.anyDate = true;
  }
  if (patch.nights !== undefined) g.dates.nights = patch.nights;
  if (patch.adults !== undefined) g.adults = patch.adults;
  if (patch.children !== undefined) g.children = patch.children;
  if (patch.rooms !== undefined) { g.rooms = patch.rooms; g.roomsDerived = false; }
  if (g.rooms === null || g.roomsDerived) {
    // One traveller needs one room: derived, not invented. More travellers: ask.
    if (g.adults === 1 && g.children === 0) { g.rooms = 1; g.roomsDerived = true; } else if (g.roomsDerived) { g.rooms = null; g.roomsDerived = false; }
  }
  if (patch.budgetText) {
    const p = parseAmount(patch.budgetText);
    if (!p) g.invalid.push(`budget: could not read an amount in "${patch.budgetText}"`);
    else {
      const t = toToman(p);
      g.budget = { toman: t.toman, scope: patch.budgetScope ?? "unspecified", assumedUnit: t.assumedUnit, text: patch.budgetText };
    }
  } else if (patch.budgetScope && g.budget) g.budget.scope = patch.budgetScope;
  if (patch.minimumHotelStars !== undefined) g.minimumHotelStars = patch.minimumHotelStars;
  if (patch.preferences) for (const p of patch.preferences) if (!g.preferences.includes(p)) g.preferences.push(p);
  if (patch.monitoringRequested !== undefined) g.monitoringRequested = patch.monitoringRequested;
  return g;
}

export type MissingField = "origin" | "destination" | "dates" | "nights_or_return" | "adults" | "rooms";

export interface SearchCandidate { departure: string; return: string; nights: number }

export interface GoalAnalysis {
  missing: MissingField[];
  conflicts: string[];
  pendingAssumptions: string[];
  /** Notes the reply must disclose (assumed Toman, derived rooms, unverified airport code...). */
  disclosures: string[];
  ready: boolean;
  /** Bounded list of concrete date pairs to search (max 3). Empty unless ready. */
  plan: SearchCandidate[];
  planNote: string | null;
}

export const MAX_CANDIDATES = 3;

export function analyze(g: TripGoal, now: Date): GoalAnalysis {
  const today = todayInTehran(now);
  const needFlights = g.intent !== "hotel_only";
  const needHotel = g.intent !== "flight_only";
  const missing: MissingField[] = [];
  const conflicts: string[] = [...g.invalid];
  const disclosures: string[] = [];

  if (needFlights && !g.origin) missing.push("origin");
  if (!g.destination) missing.push("destination");
  const d = g.dates;
  if (!d.departure && !d.window) missing.push("dates");
  const nights = d.nights ?? (d.departure && d.return ? daysBetween(d.departure, d.return) : null);
  if (nights === null && (needHotel || g.intent === "trip" || g.intent === "unknown")) missing.push("nights_or_return");
  if (g.adults === null) missing.push("adults");
  if (needHotel && g.rooms === null && g.adults !== null) missing.push("rooms");

  for (const [label, p] of [["origin", g.origin], ["destination", g.destination]] as const) {
    if (p && !p.iata) conflicts.push(`${label} "${p.input}" is not a city PEYVA can search yet`);
    else if (p && !p.verified) disclosures.push(`airport code ${p.iata} for ${p.fa} is not verified against the provider yet`);
  }
  if (g.origin?.cityId && g.origin.cityId === g.destination?.cityId) conflicts.push("origin and destination are the same city");
  if (d.departure && d.departure < today) conflicts.push(`departure ${d.departure} is in the past`);
  if (d.window && d.window.to < d.window.from) conflicts.push("date range ends before it starts");
  if (d.departure && d.return && d.return <= d.departure) conflicts.push("return date is not after the departure date");
  if (d.departure && d.return && d.nights !== null && daysBetween(d.departure, d.return) !== d.nights)
    conflicts.push(`dates give ${daysBetween(d.departure, d.return)} nights but ${d.nights} nights were requested`);
  if (nights !== null && nights > MAX_NIGHTS) conflicts.push(`${nights} nights is more than ${MAX_NIGHTS}`);
  if (d.window && nights !== null && daysBetween(d.window.from, d.window.to) < nights)
    conflicts.push(`the range ${d.window.from}..${d.window.to} is shorter than ${nights} nights`);
  const travellers = (g.adults ?? 0) + g.children;
  if (g.rooms !== null && g.adults !== null && g.rooms > travellers) conflicts.push(`${g.rooms} rooms for ${travellers} travellers`);
  if (g.budget && g.budget.toman < 100_000) conflicts.push(`budget ${g.budget.toman} Toman looks too small for a trip (Rial vs Toman?)`);
  if (d.anyDate && !d.window && !d.departure) disclosures.push("the user said the date does not matter: ask for a rough month instead of searching blindly");

  if (g.budget?.assumedUnit) disclosures.push("budget unit not stated: interpreted as Toman");
  if (g.budget?.scope === "unspecified") disclosures.push("budget treated as the total for all travellers");
  if (g.roomsDerived) disclosures.push("1 traveller: 1 room");

  const ready = missing.length === 0 && conflicts.length === 0 && g.pendingAssumptions.length === 0;
  let plan: SearchCandidate[] = [];
  let planNote: string | null = null;
  if (ready && nights !== null) {
    if (d.departure) plan = [{ departure: d.departure, return: d.return ?? addDays(d.departure, nights), nights }];
    else if (d.window) {
      const last = addDays(d.window.to, -nights);
      const span = daysBetween(d.window.from, last);
      const picks = [...new Set([d.window.from, addDays(d.window.from, Math.floor(span / 2)), last])].filter((x) => x >= today);
      plan = picks.slice(0, MAX_CANDIDATES).map((dep) => ({ departure: dep, return: addDays(dep, nights), nights }));
      planNote = `flexible range: checking ${plan.length} departure dates (${plan.map((p) => formatJalaliFa(p.departure)).join("، ")}), not every day`;
    }
  }
  return { missing, conflicts, pendingAssumptions: [...g.pendingAssumptions], disclosures, ready, plan, planNote };
}

export { emptyGoal };
