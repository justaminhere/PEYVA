/**
 * The application-level tools the LLM may call. Every call goes through: JSON parse -> zod schema ->
 * business validation (known city, real/future date, ready goal) -> bounded execution -> compact result.
 * There is no booking, payment, reminder or watch tool: such calls are rejected as unknown tools.
 */
import { z } from "zod";
import { DayExprSchema, LlmGoalPatchSchema } from "../goal/schema.ts";
import { analyze, applyPatch, type SearchCandidate } from "../goal/state.ts";
import { formatJalaliFa, monthNamesIn, resolveDay } from "../goal/dates.ts";
import type { GoalPatch, TripGoal } from "../goal/schema.ts";
import { signalsIn, type Signals } from "../goal/signals.ts";
import { parseAmount, toToman } from "../goal/persian.ts";

/**
 * Checks the LLM's patch against the user's own words. Returns a cleaned patch (fields the user never mentioned are
 * removed), what was dropped, and details the user mentioned that are still not recorded.
 */
export function crossCheckPatch(patch: GoalPatch, userText: string, goal: TripGoal): { patch: GoalPatch; dropped: string[]; unrecorded: string[]; signals: Signals } {
  const sig = signalsIn(userText);
  const p: GoalPatch = { ...patch };
  const dropped: string[] = [];
  if (p.rooms !== undefined && !sig.mentionsRooms) { delete p.rooms; dropped.push("rooms: the user did not mention rooms"); }
  if (p.minimumHotelStars !== undefined && sig.stars === null) { delete p.minimumHotelStars; dropped.push("minimumHotelStars: the user did not mention stars"); }
  if (p.nights !== undefined && sig.nights === null && !/شب/u.test(userText)) { delete p.nights; dropped.push("nights: the user did not mention nights"); }
  if (p.budgetText) {
    const a = parseAmount(p.budgetText);
    if (!a || sig.budgetToman === null || toToman(a).toman !== sig.budgetToman) { delete p.budgetText; delete p.budgetScope; dropped.push(`budgetText: "${p.budgetText ?? patch.budgetText}" is not the amount in the user's words; copy it verbatim`); }
  }
  if (p.confirmAssumptions && !sig.affirmation) { delete p.confirmAssumptions; dropped.push("confirmAssumptions: the user has not said yes; ask them to confirm"); }
  const unrecorded: string[] = [];
  if (sig.travellers !== null && p.adults === undefined && goal.adults !== sig.travellers) unrecorded.push(`travellers: the user said ${sig.travellers} (set adults/children)`);
  if (sig.budgetToman !== null && !p.budgetText && goal.budget?.toman !== sig.budgetToman) unrecorded.push("budget: the user named an amount (copy it into budgetText)");
  if (sig.stars !== null && p.minimumHotelStars === undefined && goal.minimumHotelStars !== sig.stars) unrecorded.push(`minimumHotelStars: the user said ${sig.stars}`);
  if (sig.nights !== null && p.nights === undefined && goal.dates.nights !== sig.nights) unrecorded.push(`nights: the user said ${sig.nights}`);
  if (sig.monitoring && !p.monitoringRequested && !goal.monitoringRequested) unrecorded.push("monitoringRequested: the user asked to be told later");
  return { patch: p, dropped, unrecorded, signals: sig };
}
import { findCity } from "../travel/places.ts";
import { bestOverall, compareCandidate, type CandidateComparison } from "../compare/engine.ts";
import { isFresh, validateFlightQuery, validateHotelQuery, type FlightQuery, type HotelQuery, type NormalizedFlight, type NormalizedHotel, type SearchResult } from "../travel/index.ts";
import type { Session } from "./session.ts";
import type { ToolSpec } from "../llm/types.ts";
import { cleanText, fence } from "./untrusted.ts";

export const MAX_SEARCHES_PER_TURN = 9;
/** Provider error causes that mean "stop asking this provider for now". */
const STOP_CAUSES = new Set(["network_or_geo_block", "rate_limit", "anti_bot_challenge"]);

export type ToolEvent =
  | { type: "goal_updated"; missing: string[]; ready: boolean }
  | { type: "search"; kind: "flight" | "hotel"; label: string; status: string; count: number; latencyMs: number | null; cached: boolean; error: string | null }
  | { type: "compare"; candidates: number }
  | { type: "rejected"; tool: string; reason: string };

export interface ToolOutcome { ok: boolean; content: string; events: ToolEvent[] }

const SearchFlightsArgs = z.object({
  origin: z.string().min(1).max(60).describe("city as the user wrote it"),
  destination: z.string().min(1).max(60),
  date: DayExprSchema,
  adults: z.number().int().min(1).max(9),
  children: z.number().int().min(0).max(8).optional(),
}).strict();
const SearchHotelsArgs = z.object({
  city: z.string().min(1).max(60),
  checkIn: DayExprSchema,
  checkOut: DayExprSchema,
  adults: z.number().int().min(1).max(8),
}).strict();
const CompareArgs = z.object({}).strict();

const jsonSchema = (s: z.ZodType) => { const j = z.toJSONSchema(s) as Record<string, unknown>; delete j.$schema; return j; };

/** The tools the chat LLM sees (Phase 2B: 2 tools; the ad-hoc searches are hidden to save ~1k tokens per request). */
export const CHAT_TOOL_SPECS: ToolSpec[] = [
  { name: "update_trip_goal", description: "Record what the user said in THIS message, as stated. Returns the merged goal, what is missing, conflicts and assumptions to confirm.", parameters: jsonSchema(LlmGoalPatchSchema) },
  { name: "compare_trip_options", description: "When the goal is ready: runs bounded real searches and returns a deterministic comparison. Prices come only from this tool.", parameters: jsonSchema(CompareArgs) },
];
/** Ad-hoc search tools: still implemented and validated, offered only when a runner is created with tools "all". */
export const SEARCH_TOOL_SPECS: ToolSpec[] = [
  { name: "search_flights", description: "Ad-hoc one-way flight search with the real provider.", parameters: jsonSchema(SearchFlightsArgs) },
  { name: "search_hotels", description: "Ad-hoc hotel search for a stay (single room) with the real provider.", parameters: jsonSchema(SearchHotelsArgs) },
];
/** Phase 3 tools, offered only when the session has a database. Both only PROPOSE; the user approves in the app. */
const StartMonitoringArgs = z.object({}).strict();
const ProposePreferenceArgs = z.object({
  key: z.enum(["home_city", "preferred_airlines", "min_hotel_stars", "travel_style", "budget_preference"]),
  value: z.union([z.string().min(1).max(80), z.number().int(), z.array(z.string().min(1).max(40)).max(5)]),
}).strict();
export const MEMORY_TOOL_SPECS: ToolSpec[] = [
  { name: "start_monitoring", description: "When the user wants to be told later and the goal is complete (incl. a budget): saves a DRAFT monitoring goal. The app then shows the conditions and asks the user to approve. Never say monitoring is active.", parameters: jsonSchema(StartMonitoringArgs) },
  { name: "propose_preference", description: "When the user states a lasting preference (e.g. 'usually 4-star hotels'): proposes saving it. The app asks the user; nothing is saved without their yes.", parameters: jsonSchema(ProposePreferenceArgs) },
];
export const ALL_TOOL_SPECS: ToolSpec[] = [...CHAT_TOOL_SPECS, ...SEARCH_TOOL_SPECS, ...MEMORY_TOOL_SPECS];
export const chatToolSpecs = (s: Session): ToolSpec[] => (s.persistence ? [...CHAT_TOOL_SPECS, ...MEMORY_TOOL_SPECS] : CHAT_TOOL_SPECS);
/** Kept for callers that list every tool. */
export const TOOL_SPECS = ALL_TOOL_SPECS;

function err(tool: string, reason: string, extra: Record<string, unknown> = {}): ToolOutcome {
  return { ok: false, content: JSON.stringify({ ok: false, error: reason, ...extra }), events: [{ type: "rejected", tool, reason }] };
}

function parseArgs<T>(schema: z.ZodType<T>, raw: string): { ok: true; value: T } | { ok: false; reason: string } {
  let json: unknown;
  try { json = raw.trim() ? JSON.parse(raw) : {}; } catch { return { ok: false, reason: "arguments are not valid JSON" }; }
  const r = schema.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false, reason: "invalid arguments: " + r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}

/**
 * Cross-check: if the user's message names a month, every structured (number-based) date the LLM reports must use
 * one of those months. Catches e.g. "۱۹ آذر" reported as month 11 (Bahman). Text dates are parsed by code and pass.
 */
export function monthMismatch(patchDates: unknown[], userText: string): string | null {
  const named = monthNamesIn(userText);
  if (!named.length) return null;
  for (const d of patchDates) {
    if (!d || typeof d !== "object" || "text" in d || "relative" in d) continue;
    const { calendar, month } = d as { calendar: "jalali" | "gregorian"; month: number };
    if (!named.some((n) => n.calendar === calendar && n.month === month))
      return `month mismatch: the user wrote ${named.map((n) => `${n.name} (${n.calendar} month ${n.month})`).join(", ")} but the call says ${calendar} month ${month}. Send the date as {"text": "<the user's exact words>"} instead.`;
  }
  return null;
}

/** Patch fields that change what is searched or how results are compared (monitoring / preferences do not). */
const SEARCH_RELEVANT = ["intent", "origin", "destination", "departureDate", "returnDate", "dateWindow", "month", "datesFlexible", "nights",
  "adults", "children", "rooms", "budgetText", "budgetScope", "minimumHotelStars", "confirmAssumptions"] as const;
export function affectsSearch(p: Record<string, unknown>): boolean {
  return SEARCH_RELEVANT.some((k) => p[k] !== undefined);
}

function patchDates(p: GoalPatch): unknown[] {
  return [p.departureDate, p.returnDate, p.dateWindow?.from, p.dateWindow?.to, p.month].filter(Boolean);
}

function resolveStrict(e: z.infer<typeof DayExprSchema>, now: Date): { iso: string } | { reason: string } {
  const r = resolveDay(e, now);
  if (r.error) return { reason: r.error };
  if (r.assumption) return { reason: `ambiguous date (${r.assumption}); confirm the year with the user first` };
  return { iso: r.value! };
}

function flightView(r: SearchResult<NormalizedFlight>) {
  return r.items.slice(0, 6).map((f) => ({ id: f.providerFlightId, flights: f.flightNumbers, airline: cleanText(f.airline, 40), departure: f.departureTime, arrival: f.arrivalTime, totalToman: f.totalPrice, seatsLeft: f.seatsLeft }));
}
function hotelView(r: SearchResult<NormalizedHotel>) {
  return r.items.slice(0, 8).map((h) => ({ id: h.providerHotelId, name: cleanText(h.name, 60), stars: h.stars, rating: h.rating, nights: h.nights, totalToman: h.totalPrice, roomSleeps: h.roomSleeps }));
}
const meta = <T>(r: SearchResult<T>, now: Date) => ({ provider: r.provider, status: r.status, checkedAt: r.checkedAt, fresh: isFresh(r.checkedAt, now), count: r.items.length, totalAvailable: r.totalAvailable, truncated: r.truncated, notes: r.notes.map((n) => cleanText(n, 160)), error: r.error && { cause: r.error.cause } });

export class ToolRunner {
  private readonly allowed: Set<string>;
  private readonly autoCompare: boolean;
  constructor(private s: Session, opts: { tools?: "chat" | "all"; autoCompare?: boolean } = {}) {
    this.allowed = new Set((opts.tools === "all" ? ALL_TOOL_SPECS : chatToolSpecs(s)).map((t) => t.name));
    this.autoCompare = opts.autoCompare ?? false;
  }

  private budgetLeft() { return MAX_SEARCHES_PER_TURN - this.s.turnSearches; }

  /** Cached, freshness-aware, budgeted, circuit-broken search. */
  private async flights(q: FlightQuery, events: ToolEvent[]): Promise<SearchResult<NormalizedFlight> | { blocked: string }> {
    const key = `F:${q.origin}-${q.destination}-${q.date}-${q.adults}-${q.children ?? 0}`;
    const label = `${q.origin}→${q.destination} ${q.date}`;
    return this.cached(key, label, "flight", events, () => this.s.provider.searchFlights(q));
  }
  private async hotels(q: HotelQuery, events: ToolEvent[]): Promise<SearchResult<NormalizedHotel> | { blocked: string }> {
    const key = `H:${q.city}-${q.checkIn}-${q.checkOut}-${q.adults}`;
    const label = `${q.city} ${q.checkIn}→${q.checkOut}`;
    return this.cached(key, label, "hotel", events, () => this.s.provider.searchHotels(q));
  }
  private async cached<T>(key: string, label: string, kind: "flight" | "hotel", events: ToolEvent[], run: () => Promise<SearchResult<T>>): Promise<SearchResult<T> | { blocked: string }> {
    const now = this.s.now();
    const hit = this.s.searches.get(key) as SearchResult<T> | undefined;
    if (hit && hit.status !== "error" && isFresh(hit.checkedAt, now)) {
      events.push({ type: "search", kind, label, status: hit.status, count: hit.items.length, latencyMs: null, cached: true, error: null });
      return hit;
    }
    if (this.s.blocked) return { blocked: this.s.blocked };
    if (this.budgetLeft() <= 0) return { blocked: `search budget of ${MAX_SEARCHES_PER_TURN} per message used up` };
    this.s.turnSearches++;
    const r = await run();
    this.s.searches.set(key, r);
    events.push({ type: "search", kind, label, status: r.status, count: r.items.length, latencyMs: r.latencyMs, cached: false, error: r.error ? r.error.cause : null });
    if (r.status === "error" && r.error && STOP_CAUSES.has(r.error.cause)) this.s.blocked = `provider access problem (${r.error.cause}); stopped searching for this session`;
    return r;
  }

  async run(name: string, rawArgs: string): Promise<ToolOutcome> {
    const now = this.s.now();
    const events: ToolEvent[] = [];
    // A tool that was not offered to this LLM is rejected, even if it exists in code.
    if (!this.allowed.has(name)) return err(name, `unknown tool '${cleanText(name, 40)}'. Available: ${[...this.allowed].join(", ")}. PEYVA cannot book, pay or set reminders.`);
    switch (name) {
      case "update_trip_goal": {
        const p = parseArgs(LlmGoalPatchSchema, rawArgs);
        if (!p.ok) return err(name, p.reason + ' (dates and months must be {"text": "<the user\'s words>"})');
        if (Object.keys(p.value).length === 0) return err(name, "empty update: only call update_trip_goal when the user's message adds or changes a detail");
        const mm = monthMismatch(patchDates(p.value), this.s.lastUserText());
        if (mm) return err(name, mm);
        const cc = crossCheckPatch(p.value, this.s.lastUserText(), this.s.goal);
        this.s.goal = applyPatch(this.s.goal, cc.patch, now);
        const after = crossCheckPatch({}, this.s.lastUserText(), this.s.goal).unrecorded;
        const a = analyze(this.s.goal, now);
        events.push({ type: "goal_updated", missing: a.missing, ready: a.ready });
        // Auto-compare (Phase 2B): once the goal is ready and this update changed something that matters for the search,
        // the app runs the same bounded, read-only, deterministic comparison right away. That saves the LLM a round trip.
        // Not when details the user gave are still unrecorded: the LLM must fix the goal first.
        const comparison = this.autoCompare && a.ready && after.length === 0 && affectsSearch(cc.patch as Record<string, unknown>)
          ? await this.compareNow(a, events) : undefined;
        return { ok: true, events, content: JSON.stringify({ ok: true, goal: this.s.goalSummary(), analysis: a,
          checks: { droppedBecauseUserDidNotSayIt: cc.dropped, mentionedButNotRecorded: after,
            instruction: after.length ? "Call update_trip_goal again and include the mentionedButNotRecorded items, as stated by the user." : undefined },
          ...(comparison ? { comparison, comparisonNote: "The app already searched and compared; the table is shown to the user. Answer now; do not call compare_trip_options." } : {}) }) };
      }
      case "search_flights": {
        const p = parseArgs(SearchFlightsArgs, rawArgs);
        if (!p.ok) return err(name, p.reason);
        const mmf = monthMismatch([p.value.date], this.s.lastUserText());
        if (mmf) return err(name, mmf);
        const o = findCity(p.value.origin), d = findCity(p.value.destination);
        if (!o || !d) return err(name, `unknown city: ${!o ? p.value.origin : p.value.destination}`);
        const date = resolveStrict(p.value.date, now);
        if ("reason" in date) return err(name, date.reason);
        const q: FlightQuery = { origin: o.iata, destination: d.iata, date: date.iso, adults: p.value.adults, children: p.value.children ?? 0 };
        const invalid = validateFlightQuery(q, now);
        if (invalid.length) return err(name, invalid.join("; "));
        const r = await this.flights(q, events);
        if ("blocked" in r) return err(name, r.blocked);
        return { ok: r.status !== "error", events, content: JSON.stringify({ ok: r.status !== "error", query: q, ...meta(r, now), results: fence(flightView(r)) }) };
      }
      case "search_hotels": {
        const p = parseArgs(SearchHotelsArgs, rawArgs);
        if (!p.ok) return err(name, p.reason);
        const mmh = monthMismatch([p.value.checkIn, p.value.checkOut], this.s.lastUserText());
        if (mmh) return err(name, mmh);
        const c = findCity(p.value.city);
        if (!c) return err(name, `unknown city: ${p.value.city}`);
        const ci = resolveStrict(p.value.checkIn, now), co = resolveStrict(p.value.checkOut, now);
        if ("reason" in ci) return err(name, ci.reason);
        if ("reason" in co) return err(name, co.reason);
        const q: HotelQuery = { city: c.fa, checkIn: ci.iso, checkOut: co.iso, adults: p.value.adults };
        const invalid = validateHotelQuery(q, now);
        if (invalid.length) return err(name, invalid.join("; "));
        const r = await this.hotels(q, events);
        if ("blocked" in r) return err(name, r.blocked);
        return { ok: r.status !== "error", events, content: JSON.stringify({ ok: r.status !== "error", query: q, ...meta(r, now), results: fence(hotelView(r)) }) };
      }
      case "compare_trip_options": {
        const p = parseArgs(CompareArgs, rawArgs);
        if (!p.ok) return err(name, p.reason);
        const a = analyze(this.s.goal, now);
        if (!a.ready) return err(name, "goal is not ready", { missing: a.missing, conflicts: a.conflicts, pendingAssumptions: a.pendingAssumptions });
        return { ok: true, events, content: JSON.stringify(await this.compareNow(a, events)) };
      }
      case "start_monitoring": {
        const p = parseArgs(StartMonitoringArgs, rawArgs);
        if (!p.ok) return err(name, p.reason);
        const pers = this.s.persistence;
        if (!pers) return err(name, "monitoring needs the database; it is not configured");
        if (this.s.pending) return err(name, "another approval is already waiting for the user's answer");
        const { constraintsFromTripGoal } = await import("../goals/travel.ts");
        const c = constraintsFromTripGoal(this.s.goal);
        if (!c.ok) return err(name, "goal is not complete for monitoring", { missing: c.missing });
        const d = await pers.goals.createDraft(this.s.userId, "travel_price", c.constraints, now);
        if (!d.ok) return err(name, `could not create the draft: ${d.reason}${d.detail ? " " + d.detail : ""}`);
        this.s.pending = { kind: "goal", goalId: d.goal.id, hash: d.goal.constraintsHash, summaryFa: d.summaryFa };
        return { ok: true, events, content: JSON.stringify({ ok: true, draftGoalId: d.goal.id, status: d.goal.status, notes: c.notes,
          note: "Saved as a DRAFT only. The app now shows the conditions and asks the user to approve. Monitoring is NOT active; do not say it is." }) };
      }
      case "propose_preference": {
        const p = parseArgs(ProposePreferenceArgs, rawArgs);
        if (!p.ok) return err(name, p.reason);
        if (!this.s.persistence) return err(name, "memory needs the database; it is not configured");
        if (this.s.pending) return err(name, "another approval is already waiting for the user's answer");
        const { validatePreference } = await import("../memory/preferences.ts");
        const v = validatePreference(p.value.key, p.value.value);
        if (!v.ok) return err(name, v.reason);
        this.s.pending = { kind: "preference", key: v.key, value: v.value, sourceMessageId: this.s.lastUserMessageId };
        return { ok: true, events, content: JSON.stringify({ ok: true, proposed: { key: v.key, value: v.value },
          note: "NOT saved. The app asks the user whether to remember it. Do not say it was saved." }) };
      }
      default:
        return err(name, `unknown tool '${cleanText(name, 40)}'. PEYVA can only update the goal, search and compare; it cannot book, pay or set reminders.`);
    }
  }

  /** Runs the bounded comparison for the analysed plan and returns the compact, fenced result for the LLM. */
  private async compareNow(a: ReturnType<typeof analyze>, events: ToolEvent[]) {
    const now = this.s.now();
        const results = await this.compareAll(a.plan, events);
        this.s.lastComparison = { at: now.toISOString(), goal: structuredClone(this.s.goal), planNote: a.planNote, disclosures: a.disclosures, results };
        events.push({ type: "compare", candidates: results.length });
        const best = bestOverall(results);
        return {
          ok: true, planNote: a.planNote, disclosures: a.disclosures, blocked: this.s.blocked,
          note: "The app shows the full comparison table to the user. Refer to options by number; do not restate or compute prices.",
          best: best && { candidate: best.candidateIndex + 1, totalToman: best.option.totalToman, withinBudget: best.option.withinBudget },
          candidates: results.map((c, i) => ({ n: i + 1, dates: c.candidate,
            datesFa: `${formatJalaliFa(c.candidate.departure)} تا ${formatJalaliFa(c.candidate.return)}`, status: c.status, reasons: c.reasons, stale: c.stale, options: c.options.length,
            cheapest: c.options[0] && fence({ totalToman: c.options[0].totalToman, withinBudget: c.options[0].withinBudget,
              hotel: c.options[0].hotel && cleanText(c.options[0].hotel.name, 60), airline: c.options[0].outbound && cleanText(c.options[0].outbound.airline, 40) }) })),
        };
  }

  private async compareAll(plan: SearchCandidate[], events: ToolEvent[]): Promise<CandidateComparison[]> {
    const g = this.s.goal, now = this.s.now();
    const travellers = (g.adults ?? 1) + g.children;
    const out: CandidateComparison[] = [];
    for (const c of plan) {
      const wantFlights = g.intent !== "hotel_only", wantHotel = g.intent !== "flight_only";
      const take = <T>(r: SearchResult<T> | { blocked: string } | null): SearchResult<T> | null => (r && !("blocked" in r) ? r : null);
      const ob = wantFlights ? take(await this.flights({ origin: g.origin!.iata!, destination: g.destination!.iata!, date: c.departure, adults: g.adults!, children: g.children }, events)) : null;
      const rt = wantFlights ? take(await this.flights({ origin: g.destination!.iata!, destination: g.origin!.iata!, date: c.return, adults: g.adults!, children: g.children }, events)) : null;
      const ht = wantHotel ? take(await this.hotels({ city: g.destination!.fa!, checkIn: c.departure, checkOut: c.return, adults: Math.min(travellers, 8) }, events)) : null;
      out.push(compareCandidate({ goal: g, candidate: c, outbound: ob, return: rt, hotels: ht, now }));
    }
    return out;
  }
}
