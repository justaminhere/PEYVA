/** Opt-in: launches the REAL pinned servers via uvx and checks discovery. Needs uv + PyPI access. */
import { expect, test } from "bun:test";
import { McpSession } from "../../src/mcp.ts";
import { PROVIDERS } from "../../src/providers.ts";

const run = process.env.SPIKE_REAL === "1" ? test : test.skip;
for (const p of Object.values(PROVIDERS)) {
  run(`${p.id}: real server starts and exposes the travel tools`, async () => {
    const s = await McpSession.open(p, 120_000);
    const names = new Set((await s.listTools()).map((t) => t.name));
    await s.close();
    for (const n of [p.tools.searchFlights, p.tools.searchHotels, ...p.tools.findPlace]) expect(names.has(n)).toBe(true);
  }, 150_000);
}
