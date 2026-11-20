/**
 * TravelSearchProvider backed by an unofficial MCP server (mrbilit-mcp / flytoday-mcp).
 * All MCP and provider-specific knowledge (tool names, argument shapes, place ids) stays in this file.
 */
import { McpSession, type CallOutcome } from "../mcp.ts";
import { PROVIDERS, type ProviderConfig, type ProviderId } from "../providers.ts";
import { preflight } from "../preflight.ts";
import { diagnose } from "../diagnose.ts";
import { normalizeFlights, normalizeHotels, type FlightParse, type HotelParse } from "../normalize.ts";
import { pickFlytodayHotelCity, pickMrbilitHotelCity } from "../resolve.ts";
import type { NormalizedFlight, NormalizedHotel } from "../types.ts";
import {
  validateFlightQuery, validateHotelQuery,
  type FlightQuery, type HealthReport, type HotelQuery, type SearchResult, type TravelSearchProvider,
} from "./provider.ts";

/** One provider tool call, for debugging and evidence. Not part of the application contract. */
export interface CallTrace {
  provider: ProviderId;
  tool: string;
  args: Record<string, unknown>;
  checkedAt: string;
  outcome: CallOutcome;
}

export interface McpProviderOptions {
  timeoutMs?: number;
  connectTimeoutMs?: number;
  /** Skip the DNS/TLS preflight in healthCheck (tests with a local fake server). */
  skipPreflight?: boolean;
  onCall?: (t: CallTrace) => void | Promise<void>;
  now?: () => Date;
}

interface Adapter {
  hotelPlaceTool: string;
  flightArgs(q: FlightQuery): Record<string, unknown>;
  hotelPlaceArgs(city: string): Record<string, unknown>;
  pickHotelPlace(data: unknown, city: string): string | number | null;
  hotelArgs(place: string | number, q: HotelQuery): Record<string, unknown>;
}

const needles = (city: string) => [city.trim().toLowerCase()];

const ADAPTERS: Record<ProviderId, Adapter> = {
  mrbilit: {
    hotelPlaceTool: "mb_find_place",
    flightArgs: (q) => ({ origin: q.origin, destination: q.destination, date: q.date, adults: q.adults, children: q.children ?? 0, sort: "cheapest", limit: 15 }),
    hotelPlaceArgs: (city) => ({ query: city, mode: "hotel", limit: 10 }),
    pickHotelPlace: (d, city) => pickMrbilitHotelCity(d, needles(city)),
    // Prices are for one room and do not depend on guest count (upstream docs); adults is checked in normalization.
    hotelArgs: (place, q) => ({ city: place, check_in: q.checkIn, check_out: q.checkOut, sort: "cheapest", limit: 20 }),
  },
  flytoday: {
    hotelPlaceTool: "ft_find_hotel_place",
    flightArgs: (q) => ({ origin: q.origin, destination: q.destination, date: q.date, adults: q.adults, children: q.children ?? 0, sort: "cheapest", limit: 15 }),
    hotelPlaceArgs: (city) => ({ query: city, limit: 10 }),
    pickHotelPlace: (d, city) => pickFlytodayHotelCity(d, needles(city)),
    // flytoday defaults adults to 2: always pass it.
    hotelArgs: (place, q) => ({ city_id: place, check_in: q.checkIn, check_out: q.checkOut, adults: q.adults, sort: "price", limit: 20 }),
  },
};

export class McpTravelProvider implements TravelSearchProvider {
  readonly id: ProviderId;
  private session: McpSession | null = null;
  private opening: Promise<McpSession> | null = null;
  private placeCache = new Map<string, string | number>();
  private readonly adapter: Adapter;
  private readonly now: () => Date;

  constructor(private readonly config: ProviderConfig, private readonly opts: McpProviderOptions = {}) {
    this.id = config.id;
    this.adapter = ADAPTERS[config.id];
    this.now = opts.now ?? (() => new Date());
  }

  static create(id: ProviderId, opts?: McpProviderOptions) {
    return new McpTravelProvider(PROVIDERS[id], opts);
  }

  private async getSession(): Promise<McpSession> {
    if (this.session) return this.session;
    this.opening ??= McpSession.open(this.config, this.opts.connectTimeoutMs ?? 90_000)
      .then((s) => (this.session = s))
      .finally(() => (this.opening = null));
    return this.opening;
  }

  private async call(tool: string, args: Record<string, unknown>) {
    const checkedAt = this.now().toISOString();
    let outcome: CallOutcome;
    try {
      const s = await this.getSession();
      outcome = await s.callTool(tool, args, this.opts.timeoutMs ?? 60_000);
    } catch (e) {
      outcome = { kind: "transport_error", latencyMs: 0, message: (e as Error).message };
    }
    await this.opts.onCall?.({ provider: this.id, tool, args, checkedAt, outcome });
    return { checkedAt, outcome };
  }

  private fail<T>(checkedAt: string, outcome: CallOutcome | null, message: string, cause = outcome ? diagnose(outcome) : null): SearchResult<T> {
    return {
      provider: this.id, status: "error", checkedAt, latencyMs: outcome?.latencyMs ?? null, items: [],
      totalAvailable: null, truncated: false, notes: [], error: { cause: cause ?? "unknown", message },
    };
  }

  async healthCheck(): Promise<HealthReport> {
    const checkedAt = this.now().toISOString();
    const checks: HealthReport["checks"] = [];
    if (!this.opts.skipPreflight) {
      const pf = await preflight(this.id);
      for (const c of pf.checks) checks.push({ name: `tls ${c.host}`, ok: c.tls === "ok", ms: c.ms, detail: c.error });
    }
    const t0 = performance.now();
    try {
      const s = await this.getSession();
      const names = new Set((await s.listTools()).map((t) => t.name));
      const needed = [this.config.tools.searchFlights, this.config.tools.searchHotels, ...this.config.tools.findPlace];
      const missing = needed.filter((n) => !names.has(n));
      checks.push({ name: "mcp tools", ok: missing.length === 0, ms: Math.round(performance.now() - t0), detail: missing.length ? `missing: ${missing.join(", ")}` : null });
    } catch (e) {
      checks.push({ name: "mcp tools", ok: false, ms: Math.round(performance.now() - t0), detail: (e as Error).message.split("\n")[0]! });
    }
    return { provider: this.id, ok: checks.every((c) => c.ok), checkedAt, checks };
  }

  async searchFlights(q: FlightQuery): Promise<SearchResult<NormalizedFlight>> {
    const invalid = validateFlightQuery(q, this.now());
    if (invalid.length) return this.fail(this.now().toISOString(), null, invalid.join("; "), "invalid_query");
    const { checkedAt, outcome } = await this.call(this.config.tools.searchFlights, this.adapter.flightArgs(q));
    if (outcome.kind !== "ok") return this.fail(checkedAt, outcome, "message" in outcome ? outcome.message : "error");
    return this.toResult(checkedAt, outcome.latencyMs, normalizeFlights(this.id, outcome.data, checkedAt));
  }

  async searchHotels(q: HotelQuery): Promise<SearchResult<NormalizedHotel>> {
    const invalid = validateHotelQuery(q, this.now());
    if (invalid.length) return this.fail(this.now().toISOString(), null, invalid.join("; "), "invalid_query");
    const key = q.city.trim().toLowerCase();
    let place = this.placeCache.get(key) ?? null;
    if (place === null) {
      const lookup = await this.call(this.adapter.hotelPlaceTool, this.adapter.hotelPlaceArgs(q.city));
      if (lookup.outcome.kind !== "ok")
        return this.fail(lookup.checkedAt, lookup.outcome, `hotel place lookup failed: ${"message" in lookup.outcome ? lookup.outcome.message : ""}`);
      place = this.adapter.pickHotelPlace(lookup.outcome.data, q.city);
      if (place === null)
        return this.fail(lookup.checkedAt, lookup.outcome, `no unique hotel city matches '${q.city}'`, "invalid_query");
      this.placeCache.set(key, place);
    }
    const { checkedAt, outcome } = await this.call(this.config.tools.searchHotels, this.adapter.hotelArgs(place, q));
    if (outcome.kind !== "ok") return this.fail(checkedAt, outcome, "message" in outcome ? outcome.message : "error");
    return this.toResult(checkedAt, outcome.latencyMs, normalizeHotels(this.id, outcome.data, q.checkIn, q.checkOut, checkedAt, q.adults));
  }

  private toResult<T extends { issues: string[] }>(checkedAt: string, latencyMs: number, p: FlightParse | HotelParse): SearchResult<T> {
    const items = p.rows as unknown as T[];
    const notes = [...(p.providerNote ? [p.providerNote] : []), ...p.shapeIssues];
    if ("notOnSale" in p && p.notOnSale) notes.push(`${p.notOnSale} listed without a price (not on sale)`);
    if (p.shapeIssues.length && !items.length)
      return { ...this.fail<T>(checkedAt, null, p.shapeIssues.join("; "), "upstream_api_change"), latencyMs, notes };
    return {
      provider: this.id,
      status: p.empty ? "empty" : "ok",
      checkedAt, latencyMs, items,
      totalAvailable: p.totalAvailable,
      truncated: p.totalAvailable !== null && p.totalAvailable > items.length,
      notes,
      error: null,
    };
  }

  async close() {
    const s = this.session ?? (this.opening ? await this.opening.catch(() => null) : null);
    this.session = null;
    await s?.close();
  }
}
