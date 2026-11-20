/**
 * TEST-ONLY stdio MCP server. Never used by the CLI.
 * - Generic tools exercise the client's empty / error / timeout / crash paths.
 * - `mb_*` tools imitate mrbilit-mcp's *shapes* with SYNTHETIC data (test/fixtures/synthetic) so the
 *   TravelSearchProvider boundary can be tested without the network. Values are made up.
 */
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const FX = join(import.meta.dir, "..", "fixtures", "synthetic");
const fx = (n: string) => Bun.file(join(FX, n)).json();
const text = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const toolError = (m: string) => ({ isError: true, content: [{ type: "text", text: m }] });

const server = new Server({ name: "fake-test-server", version: "0.0.0" }, { capabilities: { tools: {} } });
const names = ["empty_search", "fail_search", "slow_search", "crash", "mb_find_place", "mb_search_flights", "mb_search_hotels"];
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: names.map((name) => ({ name, description: `test tool ${name}`, inputSchema: { type: "object" as const, properties: {} } })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = (req.params.arguments ?? {}) as Record<string, string>;
  switch (req.params.name) {
    case "empty_search":
      return text({ flights: [], note: "No flights for this route and date." });
    case "fail_search":
      return toolError("Could not reach example.invalid (ConnectError).");
    case "slow_search":
      await new Promise((r) => setTimeout(r, 10_000));
      return text({});
    case "crash":
      process.exit(1);
    case "mb_find_place":
      return text(a.query === "کیش" ? { cities: [{ id: 36, name: "کیش", slug: "kish", tags: [] }], hotels: [] } : { cities: [], hotels: [] });
    case "mb_search_flights":
      if (a.destination === "KIH") return text(await fx("synthetic-mrbilit-flights.json"));
      if (a.destination === "MHD") return text({ matching: 0, not_on_sale: 0, flights: [], note: "No flights for this route and date." });
      return toolError("Could not reach flight.example (ConnectError).");
    case "mb_search_hotels": {
      const h = await fx("synthetic-mrbilit-hotels.json");
      return text({ ...h, matching: 5 }); // 2 rows but 5 matching: exercises `truncated`
    }
  }
  return toolError(`Unknown tool ${req.params.name}`);
});
await server.connect(new StdioServerTransport());
