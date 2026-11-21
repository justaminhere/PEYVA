/** The REAL OpenAI-compatible adapter against a TEST-ONLY local HTTP server (no credentials, no internet). */
import { afterAll, expect, test } from "bun:test";
import { OpenAICompatibleClient } from "../src/llm/openai-compatible.ts";
import { loadLlmConfig, describeLlm } from "../src/config.ts";
import { CHAT_TOOL_SPECS as TOOL_SPECS } from "../src/agent/tools.ts";

let mode: "tool" | "text" | "401" | "403" | "429" | "garbage" | "slow" = "tool";
let lastBody: any = null, lastAuth: string | null = null;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    lastAuth = req.headers.get("authorization");
    lastBody = await req.json();
    if (mode === "401") return Response.json({ error: { message: "bad key" } }, { status: 401 });
    if (mode === "403") return Response.json({ error: { message: "Access denied" } }, { status: 403 });
    if (mode === "429") return Response.json({ error: { message: "slow down" } }, { status: 429 });
    if (mode === "garbage") return Response.json({ nope: true });
    if (mode === "slow") { await Bun.sleep(3000); return Response.json({}); }
    const message = mode === "tool"
      ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "update_trip_goal", arguments: "{\"destination\":\"کیش\"}" } }] }
      : { role: "assistant", content: "سلام! کجا می‌خوای بری؟" };
    return Response.json({ id: "x", object: "chat.completion", created: 0, model: "test-model", choices: [{ index: 0, message, finish_reason: mode === "tool" ? "tool_calls" : "stop" }] });
  },
});
afterAll(() => server.stop(true));
const cfg = { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "sk-test-not-real", model: "test-model", timeoutMs: 1500 };
const client = new OpenAICompatibleClient(cfg);

test("sends model, tools and auth; parses tool calls", async () => {
  mode = "tool";
  const r = await client.complete([{ role: "system", content: "s" }, { role: "user", content: "کیش" }], TOOL_SPECS);
  expect(r).toMatchObject({ ok: true, toolCalls: [{ id: "c1", name: "update_trip_goal", arguments: "{\"destination\":\"کیش\"}" }] });
  expect(lastBody.model).toBe("test-model");
  expect(lastBody.tools.map((t: any) => t.function.name)).toEqual(["update_trip_goal", "compare_trip_options"]);
  expect(JSON.stringify(lastBody.tools)).not.toContain("$schema");
  expect(lastAuth).toBe("Bearer sk-test-not-real");
});

test("round-trips assistant tool calls and tool results in the next request", async () => {
  mode = "text";
  const r = await client.complete([
    { role: "user", content: "x" },
    { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "update_trip_goal", arguments: "{}" }] },
    { role: "tool", toolCallId: "c1", content: "{\"ok\":true}" },
  ], []);
  expect(r).toMatchObject({ ok: true, text: "سلام! کجا می‌خوای بری؟", toolCalls: [] });
  expect(lastBody.messages[1].tool_calls[0].function.name).toBe("update_trip_goal");
  expect(lastBody.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "{\"ok\":true}" });
  expect(lastBody.tools).toBeUndefined();
});

test("maps auth, rate limit, malformed and timeout errors", async () => {
  mode = "401"; expect(await client.complete([{ role: "user", content: "x" }], [])).toMatchObject({ ok: false, cause: "auth" });
  mode = "403"; expect(await client.complete([{ role: "user", content: "x" }], [])).toMatchObject({ ok: false, cause: "forbidden" }); // e.g. region blocked
  mode = "429"; expect(await client.complete([{ role: "user", content: "x" }], [])).toMatchObject({ ok: false, cause: "rate_limit" });
  mode = "garbage"; expect(await client.complete([{ role: "user", content: "x" }], [])).toMatchObject({ ok: false, cause: "malformed" });
  mode = "slow"; expect(await client.complete([{ role: "user", content: "x" }], [])).toMatchObject({ ok: false, cause: "timeout" });
}, 20_000);

test("unreachable endpoint maps to network", async () => {
  const dead = new OpenAICompatibleClient({ ...cfg, baseURL: "http://127.0.0.1:9/v1" });
  expect(await dead.complete([{ role: "user", content: "x" }], [])).toMatchObject({ ok: false, cause: "network" });
}, 20_000);

test("config: required vars, https rule, no secret in descriptions", () => {
  const missing = loadLlmConfig({});
  expect(missing).toMatchObject({ ok: false, missing: ["PEYVA_LLM_BASE_URL", "PEYVA_LLM_API_KEY", "PEYVA_LLM_MODEL"] });
  expect(loadLlmConfig({ PEYVA_LLM_BASE_URL: "http://example.com/v1", PEYVA_LLM_API_KEY: "k", PEYVA_LLM_MODEL: "m" })).toMatchObject({ ok: false });
  const ok = loadLlmConfig({ PEYVA_LLM_BASE_URL: "https://api.example.com/v1", PEYVA_LLM_API_KEY: "sk-secret", PEYVA_LLM_MODEL: "m" });
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(describeLlm(ok.llm)).toBe("m @ api.example.com");
    expect(new OpenAICompatibleClient(ok.llm).label).not.toContain("sk-secret");
  }
});
