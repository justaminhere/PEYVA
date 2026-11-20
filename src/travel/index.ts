/**
 * The only import point for the travel integration. The agent core sees the provider-independent
 * boundary from Phase 1.5 and nothing MCP-specific.
 */
export type {
  FlightQuery, HotelQuery, SearchResult, SearchStatus, HealthReport, TravelSearchProvider,
} from "../../experiments/travel-mcp-spike/src/travel/provider.ts";
export {
  isFresh, ageMs, todayInTehran, validateFlightQuery, validateHotelQuery, DEFAULT_MAX_AGE_MS, MAX_NIGHTS,
} from "../../experiments/travel-mcp-spike/src/travel/provider.ts";
export type { NormalizedFlight, NormalizedHotel, ProviderName } from "../../experiments/travel-mcp-spike/src/types.ts";
export { McpTravelProvider } from "../../experiments/travel-mcp-spike/src/travel/mcp-provider.ts";
