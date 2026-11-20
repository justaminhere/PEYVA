/**
 * Internal normalized travel model for the spike.
 *
 * Money is always an integer amount plus an explicit currency. Both upstream
 * servers already convert the provider's Rial to Toman (`*_toman` fields,
 * Rial // 10), so every amount here is TOMAN. Never mix with Rial without
 * going through `tomanToRial`.
 */
export type Currency = "TOMAN";
export type ProviderName = "mrbilit" | "flytoday";

/** Where a record came from: a live search endpoint, or something weaker. */
export type DataStatus = "live_search" | "partial";

export interface NormalizedFlight {
  provider: ProviderName;
  providerFlightId: string | null;
  origin: string | null;
  destination: string | null;
  departureTime: string | null;
  arrivalTime: string | null;
  airline: string | null;
  flightNumbers: string[];
  stops: number | null;
  /** One adult's fare, taxes included (provider `price_toman`). */
  price: number | null;
  /** Whole party fare (provider `total_toman`). */
  totalPrice: number | null;
  currency: Currency;
  priceBasis: "per_adult";
  seatsLeft: number | null;
  /** "listed" = the provider listed it as on sale in this search. Not a held seat. */
  availability: "listed" | "unknown";
  sourceUrl: string | null;
  checkedAt: string;
  dataStatus: DataStatus;
  issues: string[];
}

export interface NormalizedHotel {
  provider: ProviderName;
  providerHotelId: string | null;
  name: string | null;
  checkIn: string;
  checkOut: string;
  /** Computed by us from the dates. */
  nights: number;
  /** Nights as reported by the provider, to cross-check. */
  providerNights: number | null;
  /** Cheapest offer for the whole stay, one room (provider `price_toman`). */
  totalPrice: number | null;
  /** Provider's own per-night figure (`per_night_toman`). */
  providerPerNight: number | null;
  currency: Currency;
  priceBasis: "whole_stay_one_room";
  availability: "listed" | "unknown";
  roomsLeft: number | null;
  /** How many guests the priced (cheapest) room sleeps, when the provider says so. */
  roomSleeps: number | null;
  stars: number | null;
  rating: number | null;
  /** Scale of `rating` when the provider documents it, else null. */
  ratingScale: "0-5" | null;
  refundable: boolean | null;
  sourceUrl: string | null;
  checkedAt: string;
  dataStatus: DataStatus;
  issues: string[];
}

export function tomanToRial(toman: number): number {
  return toman * 10;
}
