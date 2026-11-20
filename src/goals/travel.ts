/**
 * TravelPriceGoal: "tell me when Tehran -> Kish, 3 nights, in Bahman, for 2, hotel >= 4 stars, total under 15M Toman exists".
 * Pure deterministic TypeScript on top of the Phase 2 pieces: the bounded date plan (analyze), the comparison engine
 * (compareCandidate) and the TravelSearchProvider boundary. No LLM anywhere in here.
 */
import { z } from "zod";
import { analyze, type SearchCandidate } from "../goal/state.ts";
import { emptyGoal, type TripGoal } from "../goal/schema.ts";
import { addDays, formatJalaliFa } from "../goal/dates.ts";
import { formatToman, toPersianDigits } from "../goal/persian.ts";
import { compareCandidate, type CandidateComparison } from "../compare/engine.ts";
import type { NormalizedFlight, NormalizedHotel, SearchResult, TravelSearchProvider } from "../travel/index.ts";
import type { ExecutionResult, GoalExecutor } from "./types.ts";
import type { CheckStatus } from "../db/schema.ts";

const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PlaceC = z.object({ cityId: z.string(), fa: z.string(), iata: z.string().regex(/^[A-Z]{3}$/) }).strict();

export const TravelPriceConstraintsSchema = z.object({
  origin: PlaceC,
  destination: PlaceC,
  dates: z.union([
    z.object({ mode: z.literal("fixed"), departure: Iso, return: Iso }).strict(),
    z.object({ mode: z.literal("window"), from: Iso, to: Iso }).strict(),
  ]),
  nights: z.number().int().min(1).max(30),
  adults: z.number().int().min(1).max(9),
  children: z.number().int().min(0).max(8),
  rooms: z.number().int().min(1).max(5),
  minimumHotelStars: z.number().int().min(1).max(5).nullable(),
  /** Total for the whole trip and all travellers, integer Toman. */
  budgetToman: z.number().int().min(100_000),
}).strict();
export type TravelPriceConstraints = z.infer<typeof TravelPriceConstraintsSchema>;

/** Turns the chat's validated TripGoal into monitoring constraints, or says what is still missing. */
export function constraintsFromTripGoal(g: TripGoal): { ok: true; constraints: TravelPriceConstraints; notes: string[] } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (!g.origin?.iata || !g.origin.cityId || !g.origin.fa) missing.push("origin");
  if (!g.destination?.iata || !g.destination.cityId || !g.destination.fa) missing.push("destination");
  const nights = g.dates.nights ?? (g.dates.departure && g.dates.return ? Math.round((Date.parse(g.dates.return) - Date.parse(g.dates.departure)) / 86_400_000) : null);
  if (!g.dates.departure && !g.dates.window) missing.push("dates");
  if (nights === null) missing.push("nights");
  if (g.adults === null) missing.push("adults");
  if (g.rooms === null) missing.push("rooms");
  if (!g.budget) missing.push("budget");
  if (g.pendingAssumptions.length) missing.push("confirm assumptions");
  if (missing.length) return { ok: false, missing };
  const notes: string[] = [];
  const travellers = g.adults! + g.children;
  let budget = g.budget!.toman;
  if (g.budget!.scope === "per_person") { budget *= travellers; notes.push("per-person budget converted to a trip total"); }
  const dates = g.dates.departure
    ? { mode: "fixed" as const, departure: g.dates.departure, return: g.dates.return ?? addDays(g.dates.departure, nights!) }
    : { mode: "window" as const, from: g.dates.window!.from, to: g.dates.window!.to };
  const c = TravelPriceConstraintsSchema.parse({
    origin: { cityId: g.origin!.cityId, fa: g.origin!.fa, iata: g.origin!.iata },
    destination: { cityId: g.destination!.cityId, fa: g.destination!.fa, iata: g.destination!.iata },
    dates, nights, adults: g.adults, children: g.children, rooms: g.rooms, minimumHotelStars: g.minimumHotelStars, budgetToman: budget,
  });
  return { ok: true, constraints: c, notes };
}

/** The TripGoal the deterministic Phase 2 functions expect. */
export function tripGoalFor(c: TravelPriceConstraints): TripGoal {
  const g = emptyGoal();
  g.intent = "trip";
  g.origin = { input: c.origin.fa, cityId: c.origin.cityId, fa: c.origin.fa, iata: c.origin.iata, verified: true };
  g.destination = { input: c.destination.fa, cityId: c.destination.cityId, fa: c.destination.fa, iata: c.destination.iata, verified: true };
  if (c.dates.mode === "fixed") { g.dates = { ...g.dates, mode: "fixed", departure: c.dates.departure, return: c.dates.return, nights: c.nights }; }
  else g.dates = { ...g.dates, mode: "flexible", window: { from: c.dates.from, to: c.dates.to }, nights: c.nights };
  g.adults = c.adults; g.children = c.children; g.rooms = c.rooms; g.minimumHotelStars = c.minimumHotelStars;
  g.budget = { toman: c.budgetToman, scope: "total", assumedUnit: false, text: String(c.budgetToman) };
  return g;
}

const STOP = new Set(["network_or_geo_block", "rate_limit", "anti_bot_challenge"]);

type CandidateClass = "match" | "no_match" | "incomplete" | "provider_error";

function classify(c: CandidateComparison): CandidateClass {
  const srcs = [c.sources.outbound, c.sources.return, c.sources.hotel];
  if (c.options.some((o) => o.withinBudget === true)) return "match";
  if (srcs.some((s) => s?.status === "error")) return "provider_error";
  if (srcs.some((s) => s === null || s.status === "empty")) return "incomplete";
  return "no_match"; // complete data: options over budget, or nothing satisfied the hard constraints
}

export function makeTravelPriceExecutor(provider: TravelSearchProvider, opts: { maxSearchesPerCheck?: number } = {}): GoalExecutor<TravelPriceConstraints> {
  const maxSearches = opts.maxSearchesPerCheck ?? 9;
  return {
    type: "travel_price",
    schema: TravelPriceConstraintsSchema,
    nameFa: (c) => `سفر ${c.origin.fa} به ${c.destination.fa}، ${toPersianDigits(c.nights)} شب`,
    describeFa: (c) => {
      const dates = c.dates.mode === "fixed" ? `رفت ${formatJalaliFa(c.dates.departure)}، برگشت ${formatJalaliFa(c.dates.return)}`
        : `حرکت بین ${formatJalaliFa(c.dates.from)} و ${formatJalaliFa(addDays(c.dates.to, -c.nights))} (بازگشت تا ${formatJalaliFa(c.dates.to)})`;
      return [
        `مسیر: ${c.origin.fa} به ${c.destination.fa} و برگشت`,
        `تاریخ: ${dates}؛ ${toPersianDigits(c.nights)} شب`,
        `مسافر: ${toPersianDigits(c.adults)} بزرگسال${c.children ? `، ${toPersianDigits(c.children)} کودک` : ""}؛ ${toPersianDigits(c.rooms)} اتاق`,
        `هتل: ${c.minimumHotelStars ? `حداقل ${toPersianDigits(c.minimumHotelStars)} ستاره` : "بدون شرط ستاره"}`,
        `سقف جمع پرواز رفت و برگشت + هتل: ${formatToman(c.budgetToman)} تومان`,
      ].join("\n");
    },
    expiresAt: (c) => new Date(`${c.dates.mode === "fixed" ? c.dates.departure : addDays(c.dates.to, -c.nights)}T20:30:00Z`), // end of that day in Tehran
    async run(c, { now }): Promise<ExecutionResult> {
      const checkedAt = now.toISOString();
      const goal = tripGoalFor(c);
      const a = analyze(goal, now);
      if (a.conflicts.some((x) => x.includes("in the past")) || (a.ready && a.plan.length === 0))
        return { status: "INCOMPLETE_DATA", provider: provider.id, checkedAt, summary: { reason: "all dates are in the past" }, errorReason: null, match: null, expired: true };
      if (!a.ready) return { status: "INCOMPLETE_DATA", provider: provider.id, checkedAt, summary: { conflicts: a.conflicts, missing: a.missing }, errorReason: "constraints not searchable", match: null, expired: false };

      let searches = 0;
      let stopped: string | null = null;
      const travellers = c.adults + c.children;
      const search = async <T>(run: () => Promise<SearchResult<T>>): Promise<SearchResult<T> | null> => {
        if (stopped || searches >= maxSearches) return null;
        searches++;
        const r = await run();
        if (r.status === "error" && r.error && STOP.has(r.error.cause)) stopped = r.error.cause;
        return r;
      };
      const results: CandidateComparison[] = [];
      for (const cand of a.plan as SearchCandidate[]) {
        const ob = await search<NormalizedFlight>(() => provider.searchFlights({ origin: c.origin.iata, destination: c.destination.iata, date: cand.departure, adults: c.adults, children: c.children }));
        const rt = await search<NormalizedFlight>(() => provider.searchFlights({ origin: c.destination.iata, destination: c.origin.iata, date: cand.return, adults: c.adults, children: c.children }));
        const ht = await search<NormalizedHotel>(() => provider.searchHotels({ city: c.destination.fa, checkIn: cand.departure, checkOut: cand.return, adults: Math.min(travellers, 8) }));
        results.push(compareCandidate({ goal, candidate: cand, outbound: ob, return: rt, hotels: ht, now }));
      }
      const classes = results.map(classify);
      let best: { cand: CandidateComparison; total: number; opt: CandidateComparison["options"][number] } | null = null;
      for (const r of results) for (const o of r.options) if (o.withinBudget === true && (!best || o.totalToman < best.total)) best = { cand: r, total: o.totalToman, opt: o };
      // Precedence: a real match wins; otherwise a provider error is NEVER reported as "no match".
      const status: CheckStatus = best ? "MATCH_FOUND" : classes.includes("provider_error") ? "PROVIDER_ERROR"
        : classes.includes("no_match") ? "NO_MATCH" : "INCOMPLETE_DATA";
      const errors = results.flatMap((r) => r.reasons.filter((x) => x.includes("provider error") || x.includes("not searched")));
      const summary = {
        searches, stopped, planNote: a.planNote,
        candidates: results.map((r, i) => ({ departure: r.candidate.departure, return: r.candidate.return, class: classes[i],
          cheapestTotal: r.options[0]?.totalToman ?? null, reasons: r.reasons.slice(0, 4) })),
      };
      const match = best ? {
        key: [best.cand.candidate.departure, best.opt.outbound?.id, best.opt.return?.id, best.opt.hotel?.id].join("|"),
        totalToman: best.total, provider: provider.id, checkedAt,
        details: {
          departure: best.cand.candidate.departure, return: best.cand.candidate.return, nights: best.cand.candidate.nights,
          outboundFlight: best.opt.outbound && { flightNumbers: best.opt.outbound.flightNumbers, airline: best.opt.outbound.airline, departureTime: best.opt.outbound.departureTime, totalToman: best.opt.outbound.totalToman },
          returnFlight: best.opt.return && { flightNumbers: best.opt.return.flightNumbers, airline: best.opt.return.airline, departureTime: best.opt.return.departureTime, totalToman: best.opt.return.totalToman },
          hotel: best.opt.hotel && { id: best.opt.hotel.id, name: best.opt.hotel.name, stars: best.opt.hotel.stars, rooms: best.opt.hotel.rooms, totalToman: best.opt.hotel.totalToman },
          warnings: best.opt.warnings,
        },
      } : null;
      return { status, provider: provider.id, checkedAt, summary, errorReason: status === "PROVIDER_ERROR" ? (stopped ?? errors.join("; ").slice(0, 300)) : null, match, expired: false };
    },
  };
}
