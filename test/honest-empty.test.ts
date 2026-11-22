/** Honest empty results: say when nothing was searched, instead of letting the model claim the provider "listed nothing". */
import { expect, test } from "bun:test";
import { runTurn } from "../src/agent/agent.ts";
import { Session } from "../src/agent/session.ts";
import { RecordedProvider } from "./support/recorded-provider.ts";
import { ScriptedLlm, call, say, tools } from "./support/scripted-llm.ts";

const now = () => new Date("2026-11-20T14:30:00Z");
const oneWay = { intent: "flight_only", origin: "تهران", destination: "کیش", adults: 1, departureDate: { text: "۱۹ آذر ۱۴۰۵" } };
const U = "پرواز تهران به کیش ۱۹ آذر ۱۴۰۵، یک نفر";

test("a one-way flight goal has no dates to compare: the tool says nothing was searched and asks for a return date or nights", async () => {
  const p = new RecordedProvider(now);
  const s = new Session(p, now);
  let seen: any = null;
  const llm = new ScriptedLlm([
    tools(call("update_trip_goal", oneWay)),
    (msgs) => { seen = JSON.parse(msgs.at(-1)!.content as string); return say("…"); },
  ]);
  const t = await runTurn(s, llm, U);
  expect(p.calls).toEqual([]); // no provider request was made
  expect(t.events.map((e) => e.type)).not.toContain("compare");
  expect(s.lastComparison).toBeNull();
  expect(seen.comparison.ok).toBe(false);
  expect(seen.comparison.nothingSearched).toBe(true);
  expect(seen.comparison.instruction).toContain("return date");
  expect(seen.comparison.instruction).toContain("nights");
  expect(seen.comparison.instruction).toContain("One-way");
  expect(seen.comparisonNote ?? "").not.toContain("already searched");
});

test("compare_trip_options on the same goal fails with the same explanation", async () => {
  const p = new RecordedProvider(now);
  const s = new Session(p, now);
  let seen: any = null;
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", oneWay)), tools(call("compare_trip_options", {})),
    (msgs) => { seen = JSON.parse(msgs.at(-1)!.content as string); return say("…"); }]), U);
  expect(seen.ok).toBe(false);
  expect(seen.nothingSearched).toBe(true);
});
