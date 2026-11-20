/** Phase 2B token diet: compact schema, 2 chat tools, compacted history. Measures prompt size on a scripted conversation. */
import { expect, test } from "bun:test";
import { compactHistory, runTurn, summarizeToolResult } from "../src/agent/agent.ts";
import { Session } from "../src/agent/session.ts";
import { CHAT_TOOL_SPECS } from "../src/agent/tools.ts";
import { systemPrompt } from "../src/agent/prompt.ts";
import type { ChatMessage } from "../src/llm/types.ts";
import { RecordedProvider } from "./support/recorded-provider.ts";
import { ScriptedLlm, call, say, tools } from "./support/scripted-llm.ts";

const now = () => new Date("2026-11-20T14:30:00Z");

test("only 2 tools are offered to the chat LLM and the goal schema has text-only dates", () => {
  expect(CHAT_TOOL_SPECS.map((t) => t.name)).toEqual(["update_trip_goal", "compare_trip_options"]);
  const schema = JSON.stringify(CHAT_TOOL_SPECS[0]!.parameters);
  expect(schema).not.toContain('"calendar"');
  expect(schema).not.toContain('"relative"');
});

test("summaries keep what the model needs and drop the bulk", () => {
  expect(JSON.parse(summarizeToolResult(JSON.stringify({ ok: true, goal: { a: 1 }, analysis: { missing: [] } })))).toEqual({ ok: true, note: "goal updated (the current goal is in the system prompt)" });
  expect(JSON.parse(summarizeToolResult(JSON.stringify({ ok: false, error: "x".repeat(500) }))).error.length).toBe(120);
  const cmp = JSON.parse(summarizeToolResult(JSON.stringify({ ok: true, best: { candidate: 1, totalToman: 5 }, candidates: [{ n: 1, datesFa: "۱۹ آذر", status: "complete", reasons: ["long"], cheapest: {} }] })));
  expect(cmp).toEqual({ ok: true, note: "comparison already shown to the user", best: { candidate: 1, totalToman: 5 }, candidates: [{ n: 1, datesFa: "۱۹ آذر", status: "complete" }] });
});

test("tool results of the current turn stay complete; earlier ones are summarized", () => {
  const big = JSON.stringify({ ok: true, goal: { x: "y".repeat(300) }, analysis: {} });
  const msgs: ChatMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: null, toolCalls: [{ id: "1", name: "update_trip_goal", arguments: "{}" }] },
    { role: "tool", toolCallId: "1", content: big },
    { role: "assistant", content: "q?" },
    { role: "user", content: "b" },
    { role: "assistant", content: null, toolCalls: [{ id: "2", name: "update_trip_goal", arguments: "{}" }] },
    { role: "tool", toolCallId: "2", content: big },
  ];
  const c = compactHistory(msgs);
  expect(c[2]!.content!.length).toBeLessThan(100);
  expect(c[6]!.content).toBe(big);
  expect(c.length).toBe(msgs.length); // nothing removed: tool_call ids still pair up
});

test("measured: prompt size of a 5-turn conversation, before vs after the diet", async () => {
  const s = new Session(new RecordedProvider(now), now);
  const llm = new ScriptedLlm([
    tools(call("update_trip_goal", { intent: "trip", destination: "کیش", nights: 3 })), say("از کجا؟"),
    tools(call("update_trip_goal", { origin: "تهران", adults: 1, budgetText: "۳۰ میلیون" })), say("تاریخ؟"),
    // auto-compare: the update that makes the goal ready already carries the comparison, so no compare_trip_options round trip
    tools(call("update_trip_goal", { departureDate: { text: "۱۹ آذر ۱۴۰۵" } })), say("گزینه ۱."),
    tools(call("update_trip_goal", { minimumHotelStars: 4 })), say("گزینه ۱."),
    tools(call("update_trip_goal", { monitoringRequested: true })), say("فعلاً پایش ندارم."),
  ]);
  for (const u of ["می‌خوام یه سفر سه شبه به کیش برم", "تهران، یک نفر، بودجه ۳۰ میلیون", "۱۹ آذر ۱۴۰۵", "فقط هتل چهار ستاره به بالا باشه", "اگه قیمت مناسب شد بهم خبر بده"])
    await runTurn(s, llm, u);
  const size = (m: ChatMessage[]) => JSON.stringify(m).length;
  const toolsChars = JSON.stringify(CHAT_TOOL_SPECS).length;
  const last = llm.requests.at(-1)!;
  const sentHistory = size(last.messages.slice(1)); // what was actually sent (compacted), without the system prompt
  const rawHistory = size(s.messages.slice(0, -1)); // the same conversation uncompacted, before the final reply
  const sys = systemPrompt(s).length;
  console.log(JSON.stringify({ lastRequestChars: { system: sys, tools: toolsChars, historySent: sentHistory, historyUncompacted: rawHistory },
    totalRequestsInConversation: llm.requests.length,
    totalCharsSentAllRequests: llm.requests.reduce((a, r) => a + size(r.messages) + JSON.stringify(r.tools).length, 0) }));
  // Whole conversation: every request as sent now vs. the same requests with the pre-diet tool JSON (9,791 chars, measured by
  // peyva:token-budget before the change) and uncompacted history. Same counting as peyva:token-budget (tools wrapped as functions).
  const wrapped = (t: unknown) => JSON.stringify((t as object[]).map((f) => ({ type: "function", function: f }))).length;
  let after = 0, before = 0;
  for (const r of llm.requests) {
    const sysLen = (r.messages[0]!.content as string).length;
    const hist = r.messages.slice(1);
    after += sysLen + wrapped(r.tools) + size(hist);
    before += sysLen + 9791 + size(s.messages.slice(0, hist.length));
  }
  // "before" here = the SAME requests with pre-diet tool JSON and uncompacted history. It does not add back the compare round
  // trips that auto-compare removed, so compare "after" across versions (docs/LLM_TOKEN_BUDGET.md §8), not this ratio alone.
  console.log(JSON.stringify({ requests: llm.requests.length, wholeConversationChars: { before, after, reductionPct: Math.round((1 - after / before) * 100) },
    approxTokens: { before: Math.round(before / 3.5), after: Math.round(after / 3.5) } }));
  expect(sentHistory).toBeLessThan(rawHistory * 0.6);
  expect(s.lastComparison!.results[0]!.options[0]!.totalToman).toBe(28_681_300); // behaviour unchanged (4★)
});
