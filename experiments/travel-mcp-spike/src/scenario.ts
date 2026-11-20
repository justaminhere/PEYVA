/** The fixed, reproducible Phase 1 scenario. Dates are Gregorian YYYY-MM-DD (both servers require that). */
export const SCENARIO = {
  id: "thr-kih-2026-12",
  originQuery: "تهران", // Tehran
  destinationQuery: "کیش", // Kish Island
  /** Substrings that identify the Kish city row in hotel place lookups. */
  destinationNeedles: ["کیش", "kish"],
  outboundDate: "2026-12-10",
  returnDate: "2026-12-13",
  checkIn: "2026-12-10",
  checkOut: "2026-12-13",
  adults: 1,
  rooms: 1,
  /**
   * Standard IATA codes. They are searched only after (or without) provider confirmation;
   * THR = Tehran Mehrabad, KIH = Kish Island. `locationSource` records which: "provider-confirmed" or "iata-standard".
   */
  iataFallback: { origin: "THR", destination: "KIH" },
} as const;
