import { expect, test } from "bun:test";
import { OpenAICompatibleClient } from "../src/llm/openai-compatible.ts";
import { runTurn } from "../src/agent/agent.ts";
import { Session } from "../src/agent/session.ts";
import { RecordedProvider } from "./support/recorded-provider.ts";
import { ScriptedStreamingLlm, call, say, tools } from "./support/scripted-llm.ts";
import { chunk, fakeOpenAI } from "./support/fake-openai.ts";

const cfg = (url: string) => ({ baseURL: url, apiKey: "test-key", model: "fake-model", timeoutMs: 5_000 });

test("streaming adapter: text deltas arrive in order and the final response equals their concatenation", async () => {
  const f = fakeOpenAI(() => ({ chunks: [chunk({ role: "assistant", content: "سلام" }), chunk({ content: "، از کجا" }), chunk({ content: " حرکت می‌کنی؟" }, "stop"),
    { id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [], usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 } }] }));
  const deltas: string[] = [];
  const r = await new OpenAICompatibleClient(cfg(f.url)).stream([{ role: "user", content: "سلام" }], [], (d) => deltas.push(d));
  expect(deltas).toEqual(["سلام", "، از کجا", " حرکت می‌کنی؟"]);
  expect(r).toMatchObject({ ok: true, text: "سلام، از کجا حرکت می‌کنی؟", toolCalls: [], finishReason: "stop", usage: { prompt: 120, completion: 9 } });
  expect(f.requests[0]).toMatchObject({ stream: true, stream_options: { include_usage: true }, model: "fake-model" });
  f.stop();
});

test("streaming adapter: tool-call fragments split across chunks are assembled by index", async () => {
  const f = fakeOpenAI(() => ({ chunks: [
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "update_trip", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: "_goal", arguments: '{"destination":' } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "compare_trip_options", arguments: "{}" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"کیش"}' } }] }, "tool_calls"),
  ] }));
  const deltas: string[] = [];
  const r = await new OpenAICompatibleClient(cfg(f.url)).stream([{ role: "user", content: "کیش" }], [{ name: "update_trip_goal", description: "x", parameters: { type: "object" } }], (d) => deltas.push(d));
  expect(deltas).toEqual([]);
  expect(r).toMatchObject({ ok: true, text: null, finishReason: "tool_calls",
    toolCalls: [{ id: "call_a", name: "update_trip_goal", arguments: '{"destination":"کیش"}' }, { id: "call_b", name: "compare_trip_options", arguments: "{}" }] });
  f.stop();
});

test("streaming adapter: HTTP errors map to the same causes as complete() and never throw", async () => {
  const f = fakeOpenAI(() => ({ status: 429, json: { error: { message: "Rate limit reached. Please try again in 8m9.888s (TPD)" } } }));
  const r = await new OpenAICompatibleClient({ ...cfg(f.url), timeoutMs: 2_000 }).stream([{ role: "user", content: "x" }], [], () => {});
  expect(r).toMatchObject({ ok: false, cause: "rate_limit" });
  f.stop();
});

test("agent hooks report LLM calls, live text and tool progress; the TurnResult stays authoritative", async () => {
  const now = () => new Date("2026-11-20T10:00:00Z");
  const p = new RecordedProvider(now);
  const s = new Session(p, now);
  const llm = new ScriptedStreamingLlm([
    tools(call("update_trip_goal", { intent: "trip", origin: "تهران", destination: "کیش", departureDate: { text: "۱۹ آذر ۱۴۰۵" }, nights: 3, adults: 1, budgetText: "۳۰ میلیون" })),
    say("گزینهٔ ۱ ارزان‌ترین است."),
  ]);
  const log: string[] = [];
  let text = "";
  const t = await runTurn(s, llm, "تهران به کیش ۱۹ آذر ۱۴۰۵ سه شب یک نفر بودجه ۳۰ میلیون", {
    onLlmCall: (i) => log.push(`llm:${i}`), onTextDelta: (d) => { text += d; }, onToolStart: (n) => log.push(`start:${n}`),
    onToolDone: (n, ok, ev) => log.push(`done:${n}:${ok}:${ev.map((e) => e.type).join("+")}`),
  });
  expect(log[0]).toBe("llm:1");
  expect(log[1]).toBe("start:update_trip_goal");
  expect(log[2]).toMatch(/^done:update_trip_goal:true:goal_updated\+search\+search\+search/); // auto-compare searched for real (recorded)
  expect(log[3]).toBe("llm:2");
  expect(text).toBe("گزینهٔ ۱ ارزان‌ترین است.");
  expect(t.reply).toBe(text);
  expect(t.newComparison).toBe(true);
});
