/** Auto-compare: the update that makes the goal ready runs the comparison itself (one LLM round trip less). */
import { expect, test } from "bun:test";
import { runTurn } from "../src/agent/agent.ts";
import { Session } from "../src/agent/session.ts";
import { affectsSearch } from "../src/agent/tools.ts";
import { RecordedProvider } from "./support/recorded-provider.ts";
import { ScriptedLlm, call, say, tools } from "./support/scripted-llm.ts";

const now = () => new Date("2026-11-20T14:30:00Z");
const ready = { intent: "trip", origin: "تهران", destination: "کیش", adults: 1, nights: 3, departureDate: { text: "۱۹ آذر ۱۴۰۵" } };
const U = "تهران به کیش، ۱۹ آذر ۱۴۰۵، سه شب، یک نفر";

test("the update that makes the goal ready carries the comparison; the turn needs 2 LLM requests, not 3", async () => {
  const p = new RecordedProvider(now);
  const s = new Session(p, now);
  const llm = new ScriptedLlm([
    tools(call("update_trip_goal", ready)),
    (msgs) => {
      const r = JSON.parse(msgs.at(-1)!.content as string);
      expect(r.comparison.best.totalToman).toBe(25_114_300);
      expect(r.comparisonNote).toContain("do not call compare_trip_options");
      expect(JSON.stringify(r.comparison)).toContain("untrusted_provider_data");
      return say("گزینه ۱ در بودجه است.");
    },
  ]);
  const t = await runTurn(s, llm, U);
  expect(t.llmCalls.length).toBe(2);
  expect(t.newComparison).toBe(true);
  expect(p.calls.length).toBe(3);
  expect(t.events.map((e) => e.type)).toEqual(["goal_updated", "search", "search", "search", "compare"]);
});

test("no auto-compare while the goal is not ready, or for monitoring/preference-only changes", async () => {
  const p = new RecordedProvider(now);
  const s = new Session(p, now);
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", { destination: "کیش", nights: 3 })), say("از کجا؟")]), "سه شب کیش");
  expect(p.calls).toEqual([]);
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", ready)), say("…")]), U);
  const after = s.lastComparison!.at;
  expect(p.calls.length).toBe(3);
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", { monitoringRequested: true, preferences: ["پرواز صبح"] })), say("…")]), "اگه ارزون شد خبرم کن، پرواز صبح");
  expect(s.lastComparison!.at).toBe(after); // nothing re-compared
  expect(affectsSearch({ preferences: ["x"] })).toBe(false);
  expect(affectsSearch({ minimumHotelStars: 4 })).toBe(true);
});

test("a stars change re-compares from fresh cached results: no provider request", async () => {
  const p = new RecordedProvider(now);
  const s = new Session(p, now);
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", ready)), say("…")]), U);
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", { minimumHotelStars: 4 })), say("…")]), "فقط هتل چهار ستاره به بالا باشه");
  expect(p.calls.length).toBe(3);
  expect(s.lastComparison!.results[0]!.options[0]!.totalToman).toBe(28_681_300);
});

test("no auto-compare while details the user gave are still unrecorded (the LLM must fix the goal first)", async () => {
  const p = new RecordedProvider(now);
  const s = new Session(p, now);
  // ready goal, but the message gives a traveller count with a child, which the app cannot record by itself
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", ready)), say("…")]), "تهران به کیش، ۱۹ آذر ۱۴۰۵، سه شب، دو نفر با یه بچه");
  expect(p.calls).toEqual([]);
  expect(s.lastComparison).toBeNull();
});
