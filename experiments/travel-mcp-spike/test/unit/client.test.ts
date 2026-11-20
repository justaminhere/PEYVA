import { describe, expect, test, afterAll } from "bun:test";
import { join } from "node:path";
import { McpSession } from "../../src/mcp.ts";
import { diagnose } from "../../src/diagnose.ts";
import { normalizeFlights } from "../../src/normalize.ts";

const fake = { command: process.execPath, args: ["run", join(import.meta.dir, "..", "support", "fake-server.ts")] };

describe("MCP client against the test-only fake server", () => {
  let s: McpSession;
  afterAll(async () => s?.close());

  test("connects and discovers tools", async () => {
    s = await McpSession.open(fake, 15_000);
    const names = (await s.listTools()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["empty_search", "fail_search", "slow_search", "crash"]));
  });

  test("an empty provider result is ok + empty, not an error", async () => {
    const o = await s.callTool("empty_search", {});
    expect(o.kind).toBe("ok");
    const parsed = normalizeFlights("mrbilit", o.kind === "ok" ? o.data : null, new Date().toISOString());
    expect(parsed.empty).toBe(true);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.providerNote).toContain("No flights");
  });

  test("an MCP isError result is a tool_error with a diagnosed cause", async () => {
    const o = await s.callTool("fail_search", {});
    expect(o.kind).toBe("tool_error");
    expect(diagnose(o)).toBe("network_or_geo_block");
  });

  test("a slow tool times out instead of hanging", async () => {
    const o = await s.callTool("slow_search", {}, 500);
    expect(o.kind).toBe("timeout");
    expect(o.latencyMs).toBeLessThan(3_000);
  });

  test("a crashing server process is a transport_error", async () => {
    const o = await s.callTool("crash", {}, 5_000);
    expect(["transport_error", "timeout"]).toContain(o.kind);
    expect(diagnose(o)).not.toBeNull();
  });
});

test("a missing server binary fails to connect with a clear error", async () => {
  await expect(McpSession.open({ command: "definitely-not-a-real-binary-xyz", args: [] }, 5_000)).rejects.toThrow();
});
