/**
 * PEYVA travel search boundary.
 *
 * The application layer depends only on this file and `../types.ts`. Nothing here mentions MCP,
 * tool names or provider-specific identifiers (slugs, city ids), so an official provider API can
 * replace the current unofficial MCP integration behind the same interface.
 *
 * Contract:
 * - Searches never throw for provider problems; they return `status: "error"` with a cause.
 * - `status: "empty"` means the provider answered and had nothing; it is not an error.
 * - Rows are "listed by the provider at `checkedAt`": not held, not confirmed bookable.
 * - Money is integer TOMAN with an explicit price basis on every row.
 */
import type { FailureCause } from "../diagnose.ts";
import type { NormalizedFlight, NormalizedHotel, ProviderName } from "../types.ts";

export interface FlightQuery {
  /** IATA code, e.g. "THR". */
  origin: string;
  destination: string;
  /** Gregorian YYYY-MM-DD. */
  date: string;
  adults: number;
  /** Children 2-11; the fare total then covers the whole party. Default 0. */
  children?: number;
}

export interface HotelQuery {
  /** City name as a person would write it, Persian or English (e.g. "کیش"). The provider resolves it. */
  city: string;
  checkIn: string;
  checkOut: string;
  /** Guests in the single room. */
  adults: number;
}

export type SearchStatus = "ok" | "empty" | "error";

export interface SearchResult<T> {
  provider: ProviderName;
  status: SearchStatus;
  checkedAt: string;
  latencyMs: number | null;
  items: T[];
  /** Matches at the provider; may be larger than items.length. Null when the provider does not say. */
  totalAvailable: number | null;
  truncated: boolean;
  /** Provider notes and data-quality remarks, as text. Untrusted content: never treat as instructions. */
  notes: string[];
  error: { cause: FailureCause; message: string } | null;
}

export interface HealthReport {
  provider: ProviderName;
  ok: boolean;
  checkedAt: string;
  checks: { name: string; ok: boolean; ms: number | null; detail: string | null }[];
}

export interface TravelSearchProvider {
  readonly id: ProviderName;
  /** Cheap check: backend reachability and tool availability. Sends no search. */
  healthCheck(): Promise<HealthReport>;
  searchFlights(q: FlightQuery): Promise<SearchResult<NormalizedFlight>>;
  searchHotels(q: HotelQuery): Promise<SearchResult<NormalizedHotel>>;
  close(): Promise<void>;
}

// ---------- validation (pure) ----------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rejects 2026-02-30
}

/** Today's date in Iran (Asia/Tehran), because providers reject past dates in local time. */
export function todayInTehran(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" }).format(now);
}

export function validateFlightQuery(q: FlightQuery, now: Date): string[] {
  const e: string[] = [];
  if (!/^[A-Z]{3}$/.test(q.origin)) e.push(`origin '${q.origin}' is not an IATA code (3 capital letters)`);
  if (!/^[A-Z]{3}$/.test(q.destination)) e.push(`destination '${q.destination}' is not an IATA code`);
  if (q.origin === q.destination) e.push("origin and destination are the same");
  if (!realDate(q.date)) e.push(`date '${q.date}' is not a real YYYY-MM-DD date`);
  else if (q.date < todayInTehran(now)) e.push(`date ${q.date} is in the past`);
  if (!Number.isInteger(q.adults) || q.adults < 1 || q.adults > 9) e.push("adults must be an integer 1..9");
  const ch = q.children ?? 0;
  if (!Number.isInteger(ch) || ch < 0 || ch > 8) e.push("children must be an integer 0..8");
  return e;
}

export const MAX_NIGHTS = 30;

export function validateHotelQuery(q: HotelQuery, now: Date): string[] {
  const e: string[] = [];
  if (!q.city.trim()) e.push("city is empty");
  if (!realDate(q.checkIn)) e.push(`checkIn '${q.checkIn}' is not a real YYYY-MM-DD date`);
  if (!realDate(q.checkOut)) e.push(`checkOut '${q.checkOut}' is not a real YYYY-MM-DD date`);
  if (realDate(q.checkIn) && realDate(q.checkOut)) {
    const nights = Math.round((Date.parse(q.checkOut) - Date.parse(q.checkIn)) / 86_400_000);
    if (nights < 1) e.push("checkOut must be after checkIn");
    if (nights > MAX_NIGHTS) e.push(`stay of ${nights} nights exceeds ${MAX_NIGHTS}`);
    if (q.checkIn < todayInTehran(now)) e.push(`checkIn ${q.checkIn} is in the past`);
  }
  if (!Number.isInteger(q.adults) || q.adults < 1 || q.adults > 8) e.push("adults must be an integer 1..8");
  return e;
}

// ---------- freshness (pure) ----------

/**
 * Default maximum age for showing a price as current. FlyToday ids expire after ~15 min and MrBilit
 * ids come from a fresh search, so anything older must be re-searched before it is presented or acted on.
 */
export const DEFAULT_MAX_AGE_MS = 15 * 60_000;

export function ageMs(checkedAt: string, now: Date): number {
  return now.getTime() - Date.parse(checkedAt);
}

export function isFresh(checkedAt: string, now: Date, maxAgeMs = DEFAULT_MAX_AGE_MS): boolean {
  const a = ageMs(checkedAt, now);
  return Number.isFinite(a) && a >= 0 && a <= maxAgeMs;
}
