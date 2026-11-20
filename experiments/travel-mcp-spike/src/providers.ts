/**
 * MCP server launch configs. Versions are pinned so a run is reproducible;
 * bump them deliberately after re-reading upstream docs.
 *
 * The `[browser]` extra (headless bot-check clearing) is intentionally NOT
 * installed: this spike must not bypass anti-bot protections.
 */
export type ProviderId = "mrbilit" | "flytoday";

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  command: string;
  args: string[];
  /** Env var the upstream server reads for an optional HTTP proxy. Never set by this spike. */
  proxyEnvVar: string;
  tools: { searchFlights: string; searchHotels: string; findPlace: string[] };
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  mrbilit: {
    id: "mrbilit",
    displayName: "MrBilit (mrbilit-mcp 0.5.2)",
    command: "uvx",
    args: ["--from", "mrbilit-mcp==0.5.2", "mrbilit-mcp"],
    proxyEnvVar: "MRBILIT_MCP_PROXY",
    tools: { searchFlights: "mb_search_flights", searchHotels: "mb_search_hotels", findPlace: ["mb_find_place"] },
  },
  flytoday: {
    id: "flytoday",
    displayName: "FlyToday (flytoday-mcp 0.4.2)",
    command: "uvx",
    args: ["--from", "flytoday-mcp==0.4.2", "flytoday-mcp"],
    proxyEnvVar: "FLYTODAY_MCP_PROXY",
    tools: { searchFlights: "ft_search_flights", searchHotels: "ft_search_hotels", findPlace: ["ft_find_airport", "ft_find_hotel_place"] },
  },
};
