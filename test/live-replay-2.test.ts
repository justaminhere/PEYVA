/** Regression tests replaying live chat 2 (Groq qwen/qwen3.8-27b, 2026-11-20 14:21–14:41 UTC) with a scripted LLM. */
import { expect, test } from "bun:test";
import { runTurn } from "../src/agent/agent.ts";
import { Session } from "../src/agent/session.ts";
import { DATE_WARNING, MONITORING_NOTICE } from "../src/agent/guards.ts";
import { signalsIn } from "../src/goal/signals.ts";
import { RecordedProvider } from "./support/recorded-provider.ts";
import { ScriptedLlm, call, say, tools } from "./support/scripted-llm.ts";

const now = () => new Date("2026-11-20T14:30:00Z");
const toolResults = (s: Session) => s.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content as string));

test("signals in the user's own words", () => {
  expect(signalsIn("تهران، یک نفر، بودجه ۳۰ میلیون")).toMatchObject({ travellers: 1, budgetToman: 30_000_000, mentionsRooms: false, nights: null });
  expect(signalsIn("یک نفر بزرگ سال بودجه هم 200 ملیون تومن")).toMatchObject({ travellers: 1, budgetToman: 200_000_000 });
  expect(signalsIn("می‌خوام یه سفر سه شبه به کیش برم").nights).toBe(3);
  expect(signalsIn("سه شنبه میرم").nights).toBeNull(); // Tuesday, not three nights
  expect(signalsIn("فقط هتل چهار ستاره به بالا باشه").stars).toBe(4);
  expect(signalsIn("اگه قیمت مناسب شد بهم خبر بده").monitoring).toBe(true);
  expect(signalsIn("آره درسته").affirmation).toBe(true);
  expect(signalsIn("۲۰۰ میلیون ریال").budgetToman).toBe(20_000_000);
});

test("Groq 400 'tool not in request.tools' (live: 'updateTripGoal') is retried once with a correction", async () => {
  const s = new Session(new RecordedProvider(now), now);
  const llm = new ScriptedLlm([
    { ok: false, cause: "bad_request", message: "400 tool call validation failed: attempted to call tool 'updateTripGoal' which was not in request.tools" },
    (msgs) => { expect(msgs.at(-1)!.content as string).toContain("update_trip_goal"); return tools(call("update_trip_goal", { origin: "تهران", adults: 1, budgetText: "۳۰ میلیون" })); },
    say("تاریخ؟"),
  ]);
  const t = await runTurn(s, llm, "تهران، یک نفر، بودجه ۳۰ میلیون");
  expect(t.llmError).toBeNull();
  expect(t.llmCalls.map((c) => c.ok)).toEqual([false, true, true]);
  expect(s.goal).toMatchObject({ adults: 1, budget: { toman: 30_000_000 } });
  // the correction is transient: not stored in the conversation
  expect(s.messages.some((m) => m.role === "system")).toBe(false);
});

test("live turn 3: invented rooms dropped, missed travellers + budget reported back and fixed by the retry", async () => {
  const s = new Session(new RecordedProvider(now), now);
  const llm = new ScriptedLlm([
    tools(call("update_trip_goal", { origin: "تهران", preferences: ["یک نفر"], rooms: 1 })), // exactly the live call
    (msgs) => {
      const r = JSON.parse(msgs.at(-1)!.content as string);
      expect(r.checks.droppedBecauseUserDidNotSayIt.join()).toContain("rooms");
      expect(r.checks.mentionedButNotRecorded.join()).toContain("travellers");
      expect(r.checks.mentionedButNotRecorded.join()).toContain("budget");
      return tools(call("update_trip_goal", { adults: 1, budgetText: "۳۰ میلیون" }));
    },
    say("تاریخ رفت؟"),
  ]);
  const t = await runTurn(s, llm, "تهران، یک نفر، بودجه ۳۰ میلیون");
  expect(s.goal).toMatchObject({ adults: 1, rooms: 1, roomsDerived: true, budget: { toman: 30_000_000 } });
  expect(t.warnings).toEqual([]);
});

test("if the LLM never records what the user said, the user sees a warning", async () => {
  const s = new Session(new RecordedProvider(now), now);
  const t = await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", { origin: "تهران" })), say("تاریخ؟")]), "تهران، یک نفر، بودجه ۳۰ میلیون");
  const w = t.warnings.join();
  expect(w).toContain("تعداد مسافر");
  expect(w).toContain("بودجه");
});

test("an invented budget or self-confirmation is dropped", async () => {
  const s = new Session(new RecordedProvider(now), now);
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", { destination: "کیش", departureDate: { text: "۱۰ دی" } })), say("دی ۱۴۰۵؟")]), "۱۰ دی کیش");
  expect(s.goal.pendingAssumptions.length).toBe(1);
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", { adults: 1, budgetText: "۵۰ میلیون", confirmAssumptions: true })), say("…")]), "یک نفر");
  const r = toolResults(s).at(-1);
  expect(r.checks.droppedBecauseUserDidNotSayIt.join()).toContain("budgetText");
  expect(r.checks.droppedBecauseUserDidNotSayIt.join()).toContain("confirmAssumptions");
  expect(s.goal.budget).toBeNull();
  expect(s.goal.pendingAssumptions.length).toBe(1);
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", { confirmAssumptions: true })), say("…")]), "آره درسته");
  expect(s.goal.pendingAssumptions).toEqual([]);
});

test("live turns 4–5: re-stating the same date without the year adds no new assumption", async () => {
  const s = new Session(new RecordedProvider(now), now);
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", { departureDate: { text: "۱۹ آذر ۱۴۰۵" } })), say("…")]), "۱۹ آذر ۱۴۰۵");
  await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", { departureDate: { text: "19 آذر" } })), say("…")]), "من این تاریخ میخوام برم 19 آذر");
  expect(s.goal.dates.departure).toBe("2026-12-10");
  expect(s.goal.pendingAssumptions).toEqual([]);
});

test("live turn 8: monitoring asked but never recorded by the LLM -> the app records it and shows the notice", async () => {
  const s = new Session(new RecordedProvider(now), now);
  const t = await runTurn(s, new ScriptedLlm([say("فعلاً امکان پایش قیمت را ندارم.")]), "اگه قیمت مناسب شد بهم خبر بده");
  expect(s.goal.monitoringRequested).toBe(true);
  expect(t.appActions.join()).toContain("monitoringRequested");
  expect(t.warnings).toContain(MONITORING_NOTICE);
});

test("live turn 4: mentioning today's month (Aban) is not a date warning", async () => {
  const s = new Session(new RecordedProvider(now), now);
  const t = await runTurn(s, new ScriptedLlm([tools(call("update_trip_goal", { departureDate: { text: "۱۹ آذر ۱۴۰۵" } })),
    say("الان ۲۹ آبان ۱۴۰۵ هستیم، پس ۱۹ آذر یعنی حدود دو هفته دیگه.")]), "۱۹ آذر ۱۴۰۵");
  expect(t.warnings).not.toContain(DATE_WARNING);
});
