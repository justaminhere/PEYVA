import type { NormalizedFlight, NormalizedHotel, ProviderName } from "./types.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** Whole nights between two YYYY-MM-DD dates, computed in UTC (no DST drift). */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new RangeError(`bad date ${checkIn} / ${checkOut}`);
  return Math.round((b - a) / 86_400_000);
}

export interface FlightParse {
  rows: NormalizedFlight[];
  /** Provider-reported list was present and empty. */
  empty: boolean;
  /** How many matched at the provider (may exceed rows: the list is capped by `limit`). Null if not reported. */
  totalAvailable: number | null;
  /** Flights the provider listed without a price (not on sale). Null if not reported. */
  notOnSale: number | null;
  providerNote: string | null;
  shapeIssues: string[];
}

/**
 * MrBilit `mb_search_flights` one-way result:
 * { from, to, matching, not_on_sale, airlines, flights: [{ flight_id, price_toman, total_toman,
 *   seats_left, cabin, charter, baggage, segments: [{ from, to, departure, arrival, stops, flights, airline }] }], note? }
 * FlyToday `ft_search_flights` one-way result:
 * { from, to, date, flights: [{ airline, airline_code, flight_no, from, to, departure, arrival, stops,
 *   seats_left, price_toman, total_toman, fare_source_code, key }], paging, note? }
 */
export function normalizeFlights(provider: ProviderName, data: unknown, checkedAt: string): FlightParse {
  const shapeIssues: string[] = [];
  const none = { rows: [], empty: false, totalAvailable: null, notOnSale: null };
  if (!isObj(data)) return { ...none, providerNote: null, shapeIssues: ["response is not a JSON object"] };
  const list = data.flights;
  if (!Array.isArray(list)) return { ...none, providerNote: str(data.note), shapeIssues: ["no `flights` array"] };
  const rows = list.map((f, i): NormalizedFlight => {
    const issues: string[] = [];
    if (!isObj(f)) return blankFlight(provider, checkedAt, [`flights[${i}] is not an object`]);
    let r: Omit<NormalizedFlight, "provider" | "currency" | "priceBasis" | "sourceUrl" | "checkedAt" | "dataStatus" | "issues" | "availability">;
    if (provider === "mrbilit") {
      // MrBilit: one `segment` per direction (its own legs carry the connections). A one-way search has one.
      // Several segments = a round-trip package priced for both ways: not modelled here, so flag it.
      const segs = Array.isArray(f.segments) ? f.segments.filter(isObj) : [];
      if (!segs.length) issues.push("no segments");
      if (segs.length > 1) issues.push(`${segs.length} directions in one fare (round-trip package): only the first is mapped`);
      const seg = segs[0];
      r = {
        providerFlightId: str(f.flight_id),
        origin: seg ? str(seg.from) : null,
        destination: seg ? str(seg.to) : null,
        departureTime: seg ? str(seg.departure) : null,
        arrivalTime: seg ? str(seg.arrival) : null,
        airline: seg ? str(seg.airline) : null,
        flightNumbers: seg && Array.isArray(seg.flights) ? seg.flights.filter((x): x is string => typeof x === "string") : [],
        stops: seg ? int(seg.stops) : null,
        price: int(f.price_toman),
        totalPrice: int(f.total_toman),
        seatsLeft: int(f.seats_left),
      };
    } else {
      r = {
        providerFlightId: str(f.fare_source_code) ?? str(f.key),
        origin: str(f.from),
        destination: str(f.to),
        departureTime: str(f.departure),
        arrivalTime: str(f.arrival),
        airline: str(f.airline_fa) ?? str(f.airline),
        flightNumbers: str(f.flight_no) ? str(f.flight_no)!.split(" + ") : [],
        stops: int(f.stops),
        price: int(f.price_toman),
        totalPrice: int(f.total_toman),
        seatsLeft: int(f.seats_left),
      };
    }
    if (r.price === null) issues.push("missing price_toman");
    if (r.departureTime === null) issues.push("missing departure time");
    const availability = r.price !== null ? "listed" : "unknown";
    return {
      provider, ...r, currency: "TOMAN", priceBasis: "per_adult", availability,
      sourceUrl: null, checkedAt, dataStatus: issues.length ? "partial" : "live_search", issues,
    };
  });
  return {
    rows, empty: list.length === 0,
    totalAvailable: int(data.matching) ?? (isObj(data.paging) ? int(data.paging.total) : null),
    notOnSale: int(data.not_on_sale),
    providerNote: str(data.note), shapeIssues,
  };
}

function blankFlight(provider: ProviderName, checkedAt: string, issues: string[]): NormalizedFlight {
  return {
    provider, providerFlightId: null, origin: null, destination: null, departureTime: null, arrivalTime: null,
    airline: null, flightNumbers: [], stops: null, price: null, totalPrice: null, currency: "TOMAN",
    priceBasis: "per_adult", seatsLeft: null, availability: "unknown", sourceUrl: null, checkedAt,
    dataStatus: "partial", issues,
  };
}

export interface HotelParse {
  rows: NormalizedHotel[];
  empty: boolean;
  /** Hotels matching at the provider; rows may be fewer because of `limit`. Null if not reported. */
  totalAvailable: number | null;
  providerNote: string | null;
  shapeIssues: string[];
}

/**
 * MrBilit `mb_search_hotels`: { nights, available_hotels, matching, hotels: [{ id, name, hotel, stars, rating(0-5),
 *   reviews, price_toman (whole stay, 1 room), per_night_toman, refundable, ... }], note? }
 * FlyToday `ft_search_hotels`: { check_in, check_out, nights, hotel_search_id, total_hotels, page,
 *   hotels: [{ hotel_id | property_id, name, stars, score, price_toman (whole stay), per_night_toman,
 *   refundable, rooms_left, ... }], note? }
 */
export function normalizeHotels(
  provider: ProviderName, data: unknown, checkIn: string, checkOut: string, checkedAt: string, adults = 1,
): HotelParse {
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1) throw new RangeError(`check_out must be after check_in (${checkIn} -> ${checkOut})`);
  const none = { rows: [], empty: false, totalAvailable: null };
  if (!isObj(data)) return { ...none, providerNote: null, shapeIssues: ["response is not a JSON object"] };
  const list = data.hotels;
  if (!Array.isArray(list)) return { ...none, providerNote: str(data.note), shapeIssues: ["no `hotels` array"] };
  const shapeIssues: string[] = [];
  const providerNights = int(data.nights);
  if (providerNights !== null && providerNights !== nights)
    shapeIssues.push(`provider nights ${providerNights} != computed ${nights}`);
  const rows = list.map((h, i): NormalizedHotel => {
    const issues: string[] = [];
    const H = isObj(h) ? h : {};
    if (!isObj(h)) issues.push(`hotels[${i}] is not an object`);
    const id = provider === "mrbilit"
      ? (int(H.id) !== null ? String(int(H.id)) : str(H.hotel))
      : (int(H.hotel_id) ?? int(H.property_id)) !== null ? String(int(H.hotel_id) ?? int(H.property_id)) : null;
    const total = int(H.price_toman);
    const perNight = int(H.per_night_toman);
    if (total === null) issues.push("missing price_toman");
    // Cross-check the provider's per-night figure against our own arithmetic (both round/floor: allow 1 Toman).
    if (total !== null && perNight !== null && Math.abs(total / nights - perNight) > 1)
      issues.push(`per_night_toman ${perNight} inconsistent with ${total}/${nights}`);
    const roomsLeft = int(H.rooms_left);
    const roomSleeps = provider === "mrbilit" ? int(H.cheapest_room_sleeps) : null;
    // MrBilit prices the cheapest room regardless of guest count; it may not fit the party.
    if (roomSleeps !== null && roomSleeps < adults) issues.push(`cheapest room sleeps ${roomSleeps} < ${adults} adults`);
    return {
      provider,
      providerHotelId: id,
      name: str(H.name),
      checkIn, checkOut, nights, providerNights,
      totalPrice: total,
      providerPerNight: perNight,
      currency: "TOMAN",
      priceBasis: "whole_stay_one_room",
      availability: total !== null ? "listed" : "unknown",
      roomsLeft,
      roomSleeps,
      stars: num(H.stars),
      rating: provider === "mrbilit" ? num(H.rating) : num(H.score),
      ratingScale: provider === "mrbilit" ? "0-5" : null, // FlyToday does not document its score scale
      refundable: bool(H.refundable),
      sourceUrl: null,
      checkedAt,
      dataStatus: issues.length ? "partial" : "live_search",
      issues,
    };
  });
  return {
    rows, empty: list.length === 0,
    totalAvailable: int(data.matching) ?? int(data.total_hotels),
    providerNote: str(data.note), shapeIssues,
  };
}

/** Cheapest row by a price selector; nulls ignored. Deterministic tie-break by id. */
export function cheapest<T>(rows: T[], price: (r: T) => number | null, id: (r: T) => string | null): T | null {
  let best: T | null = null;
  for (const r of rows) {
    const p = price(r);
    if (p === null) continue;
    const bp = best === null ? null : price(best);
    if (bp === null || p < bp || (p === bp && (id(r) ?? "") < (id(best!) ?? ""))) best = r;
  }
  return best;
}
