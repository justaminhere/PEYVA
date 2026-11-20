/**
 * TEST-ONLY TravelSearchProvider that answers from REAL recorded MrBilit responses
 * (experiments/travel-mcp-spike/test/fixtures/recorded). It never touches the network.
 * Queries that have no recording return a provider error, so tests can't silently pass on missing data.
 */
import { join } from "node:path";
import { normalizeFlights, normalizeHotels } from "../../experiments/travel-mcp-spike/src/normalize.ts";
import type { FlightQuery, HealthReport, HotelQuery, SearchResult, TravelSearchProvider, NormalizedFlight, NormalizedHotel } from "../../src/travel/index.ts";

const DIR = join(import.meta.dir, "..", "..", "experiments", "travel-mcp-spike", "test", "fixtures", "recorded");
const load = (n: string) => require(join(DIR, n)) as { response: unknown };

export class RecordedProvider implements TravelSearchProvider {
  readonly id = "mrbilit" as const;
  calls: string[] = [];
  /** Optional overrides to simulate errors/empties/injection for a given call key. */
  constructor(private clock: () => Date, private overrides: Record<string, (base: unknown) => unknown> = {}, private failing = new Set<string>()) {}

  async healthCheck(): Promise<HealthReport> {
    return { provider: "mrbilit", ok: true, checkedAt: this.clock().toISOString(), checks: [] };
  }

  private result<T>(items: T[], extra: Partial<SearchResult<T>>): SearchResult<T> {
    return { provider: "mrbilit", status: items.length ? "ok" : "empty", checkedAt: this.clock().toISOString(), latencyMs: 1, items,
      totalAvailable: items.length, truncated: false, notes: [], error: null, ...extra };
  }

  async searchFlights(q: FlightQuery): Promise<SearchResult<NormalizedFlight>> {
    const key = `F:${q.origin}-${q.destination}-${q.date}`;
    this.calls.push(key);
    if (this.failing.has(key)) return { ...this.result<NormalizedFlight>([], {}), status: "error", error: { cause: "network_or_geo_block", message: "recorded test failure" } };
    const file = q.origin === "THR" && q.destination === "KIH" ? "mrbilit-flights-THR-KIH-2026-12-10.json"
      : q.origin === "KIH" && q.destination === "THR" ? "mrbilit-flights-KIH-THR-2026-12-13.json" : null;
    if (!file) return this.result<NormalizedFlight>([], { notes: ["No flights for this route and date."] });
    let data = load(file).response as { flights: { segments: { departure: string; arrival: string }[] }[] };
    data = structuredClone(data);
    // Shift recorded dates onto the requested date so candidates other than the recorded day can be tested.
    for (const f of data.flights) for (const s of f.segments) { s.departure = q.date + s.departure.slice(10); s.arrival = q.date + s.arrival.slice(10); }
    const shaped = this.overrides[key]?.(data) ?? data;
    const p = normalizeFlights("mrbilit", shaped, this.clock().toISOString());
    return this.result(p.rows, { totalAvailable: p.totalAvailable, truncated: (p.totalAvailable ?? 0) > p.rows.length });
  }

  async searchHotels(q: HotelQuery): Promise<SearchResult<NormalizedHotel>> {
    const key = `H:${q.city}-${q.checkIn}-${q.checkOut}`;
    this.calls.push(key);
    if (this.failing.has(key)) return { ...this.result<NormalizedHotel>([], {}), status: "error", error: { cause: "rate_limit", message: "recorded test failure" } };
    const base = load("mrbilit-hotels-kish-2026-12-10_13.json").response as { nights: number };
    const nights = Math.round((Date.parse(q.checkOut) - Date.parse(q.checkIn)) / 86_400_000);
    if (nights !== 3) return this.result<NormalizedHotel>([], { notes: ["no recording for this stay length"] });
    const shaped = this.overrides[key]?.(structuredClone(base)) ?? base;
    const p = normalizeHotels("mrbilit", shaped, q.checkIn, q.checkOut, this.clock().toISOString(), q.adults);
    return this.result(p.rows, { totalAvailable: p.totalAvailable, truncated: (p.totalAvailable ?? 0) > p.rows.length });
  }

  async close() {}
}
