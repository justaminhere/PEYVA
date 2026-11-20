import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../src/db/client.ts";
import { conversations, goals, goalChecks, messages, notifications, preferences } from "../src/db/schema.ts";
import { ScriptedLlm, ScriptedStreamingLlm, call, say, tools } from "./support/scripted-llm.ts";
import { webApp } from "./support/web.ts";
import { freshDb } from "./support/pg.ts";

let h: DbHandle & { url: string };
let clock = new Date("2026-11-20T10:00:00Z");
const now = () => clock;
const DAY = 24 * 3_600_000;
beforeAll(async () => { h = await freshDb(); });
afterAll(() => h.close());
beforeEach(async () => {
  clock = new Date("2026-11-20T10:00:00Z");
  for (const t of [notifications, goalChecks, goals, preferences, messages, conversations]) await h.db.delete(t);
});

const TEXT = "سفر ۳ شبه تهران به کیش ۱۹ آذر ۱۴۰۵، یک نفر، یک اتاق، زیر ۳۰ میلیون؛ اگه پیدا شد خبرم کن";
const goalCall = tools(call("update_trip_goal", { intent: "trip", origin: "تهران", destination: "کیش", departureDate: { text: "۱۹ آذر ۱۴۰۵" },
  nights: 3, adults: 1, rooms: 1, budgetText: "۳۰ میلیون", monitoringRequested: true }));

test("after a server restart the latest conversation resumes: goal, LLM context, cards and a still-valid pending approval", async () => {
  const before = await webApp(h, new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید می‌کنی؟")]), now, { resumeMaxAgeMs: DAY });
  const st1 = (await before.chat(TEXT)).of("state")[0];
  // --- restart: a brand-new app and session factory over the same database ---
  clock = new Date(clock.getTime() + 30 * 60_000);
  const llm = new ScriptedLlm([say("بله، هنوز همان سفر ۱۹ آذر است.")]);
  const after = await webApp(h, llm, now, { resumeMaxAgeMs: DAY });
  const s = await (await after.call("/api/state")).json() as any;
  expect(s.resumed).toMatchObject({ savedAtFa: expect.stringContaining("۱۴۰۵") });
  expect(s.transcript.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  expect(s.goal).toMatchObject({ origin: "تهران", destination: "کیش", adults: 1, budget: { toman: 30_000_000 } });
  expect(s.cards.candidates[0].options[0].totalToman).toBe(25_114_300);
  expect(s.cards.candidates[0].staleFa).toContain("قدیمی‌تر از ۱۵ دقیقه"); // restored results are honestly marked old
  expect(s.pending).toMatchObject({ kind: "goal", goalId: st1.pending.goalId });
  // the LLM sees the earlier conversation (text only) and the goal in the system prompt
  await after.chat("هنوز همون سفره؟");
  const req = llm.requests[0]!.messages;
  expect(req.filter((m) => m.role === "user").map((m) => m.content)).toEqual([TEXT, "هنوز همون سفره؟"]);
  expect(req[0]!.content as string).toContain("کیش");
  // ...and the restored approval still works, against the database
  const ok = await (await after.call("/api/approval", { method: "POST", body: JSON.stringify({ decision: "approve", goalId: st1.pending.goalId }) })).json() as any;
  expect(ok.goals[0]).toMatchObject({ id: st1.pending.goalId, status: "active" });
  expect((await h.db.select().from(conversations))).toHaveLength(1); // continued, not duplicated
});

test("the resumed LLM context is the live session's context: failed-LLM replies and approval texts are not fed back as assistant turns", async () => {
  const before = await webApp(h, new ScriptedStreamingLlm([say("از کجا حرکت می‌کنی؟"), { ok: false, cause: "rate_limit", message: "try again in 8m (TPD)" }]), now, { resumeMaxAgeMs: DAY });
  await before.chat("می‌خوام برم کیش");
  const failed = await before.chat("از تهران");
  expect(failed.of("reply")[0].llmError).toContain("rate_limit");
  const llm = new ScriptedLlm([say("باشه")]);
  const after = await webApp(h, llm, now, { resumeMaxAgeMs: DAY });
  const s = await (await after.call("/api/state")).json() as any;
  expect(s.transcript.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant"]); // the user still sees everything
  await after.chat("یک نفر");
  const ctx = llm.requests[0]!.messages.filter((m) => m.role !== "system").map((m) => `${m.role}:${m.content}`);
  expect(ctx).toEqual(["user:می‌خوام برم کیش", "assistant:از کجا حرکت می‌کنی؟", "user:از تهران", "user:یک نفر"]);
});

test("a pending approval is dropped on resume if the draft changed or was canceled meanwhile (e.g. from the CLI)", async () => {
  const before = await webApp(h, new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید؟")]), now, { resumeMaxAgeMs: DAY });
  const id = (await before.chat(TEXT)).of("state")[0].pending.goalId;
  await before.ctx.goals.cancel("amin", id, clock);
  const after = await webApp(h, new ScriptedLlm([]), now, { resumeMaxAgeMs: DAY });
  const s = await (await after.call("/api/state")).json() as any;
  expect(s.resumed).not.toBeNull();
  expect(s.pending).toBeNull();
  expect((await after.call("/api/approval", { method: "POST", body: JSON.stringify({ decision: "approve", goalId: id }) })).status).toBe(409);
});

test("conversations older than the window, unreadable snapshots and 'گفتگوی تازه' are never resumed or merged", async () => {
  const before = await webApp(h, new ScriptedStreamingLlm([goalCall, say("باشه")]), now, { resumeMaxAgeMs: DAY });
  await before.chat(TEXT);
  clock = new Date(clock.getTime() + 2 * DAY);
  let s = await (await (await webApp(h, new ScriptedLlm([]), now, { resumeMaxAgeMs: DAY })).call("/api/state")).json() as any;
  expect(s).toMatchObject({ resumed: null, transcript: [], cards: null });
  expect(s.goal.destination).toBeNull();

  await h.db.update(conversations).set({ state: { v: 99, goal: "?" }, updatedAt: clock });
  s = await (await (await webApp(h, new ScriptedLlm([]), now, { resumeMaxAgeMs: DAY })).call("/api/state")).json() as any;
  expect(s).toMatchObject({ resumed: null, transcript: [] });

  const a = await webApp(h, new ScriptedStreamingLlm([goalCall, say("باشه")]), now, { resumeMaxAgeMs: DAY });
  await a.chat(TEXT);
  await a.call("/api/reset", { method: "POST", body: "{}" });
  s = await (await a.call("/api/state")).json() as any;
  expect(s).toMatchObject({ resumed: null, transcript: [], cards: null }); // reset = a new conversation, even in the same process
});

test("resuming is off when the window is 0 (tests and opt-out)", async () => {
  const before = await webApp(h, new ScriptedStreamingLlm([goalCall, say("باشه")]), now, { resumeMaxAgeMs: 0 });
  await before.chat(TEXT);
  const s = await (await (await webApp(h, new ScriptedLlm([]), now, { resumeMaxAgeMs: 0 })).call("/api/state")).json() as any;
  expect(s.resumed).toBeNull();
  const convs = await h.db.select().from(conversations).where(eq(conversations.userId, "amin"));
  expect(convs.length).toBe(2);
});
