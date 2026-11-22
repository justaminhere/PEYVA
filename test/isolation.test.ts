/**
 * Data isolation between visitors (public mode). Visitor A owns an approved monitoring goal, an alert, a conversation
 * and a preference; visitor B (another cookie) tries every route and guesses ids. B must see nothing of A's, change
 * nothing of A's, and the LLM request built for B must not contain A's data.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../src/db/client.ts";
import { goals, messages, notifications, preferences, goalChecks } from "../src/db/schema.ts";
import { ScriptedStreamingLlm, call, say, tools } from "./support/scripted-llm.ts";
import { publicWebApp } from "./support/web.ts";
import { freshDb } from "./support/pg.ts";

let h: DbHandle & { url: string };
const now = () => new Date("2026-11-20T10:00:00Z");
beforeAll(async () => { h = await freshDb(); });
afterAll(() => h.close());
beforeEach(async () => { for (const t of [notifications, goalChecks, goals, preferences, messages]) await h.db.delete(t); });

// Values that appear nowhere in the UI's placeholders or the system prompt, so any hit is a real leak.
const TEXT = "سفر ۳ شبه شیراز به مشهد ۲۷ آذر ۱۴۰۵، یک نفر، یک اتاق، زیر ۴۲ میلیون؛ اگه پیدا شد خبرم کن";
const SECRET_WORD = "شیراز";
const LEAKS = [SECRET_WORD, "مشهد", "۴۲ میلیون", "ارومیه"];
const goalCall = tools(call("update_trip_goal", { intent: "trip", origin: "شیراز", destination: "مشهد",
  departureDate: { text: "۲۷ آذر ۱۴۰۵" }, nights: 3, adults: 1, rooms: 1, budgetText: "۴۲ میلیون", monitoringRequested: true }));
const post = (body: unknown = {}) => ({ method: "POST", body: JSON.stringify(body) });

/** A owns an active goal, a stored alert, a preference and a conversation; B is a second, empty visitor. */
async function scene() {
  const llm = new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید می‌کنی؟"), say("سلام! چطور کمک کنم؟")]);
  const w = await publicWebApp(h, llm, now);
  const a = w.browser(), b = w.browser("198.51.100.9");
  const goalId = (await a.chat(TEXT)).of("state")[0].pending.goalId as number;
  await a.call("/api/approval", post({ decision: "approve", goalId }));
  const aState = await (await a.call("/api/state")).json() as any;
  const aUser = aState.userId as string;
  await h.db.insert(notifications).values({ userId: aUser, goalId, type: "match", channel: "in_app", payload: { secret: SECRET_WORD },
    deliveryStatus: "stored", deduplicationKey: `iso:${goalId}:in_app` });
  await h.db.insert(preferences).values({ userId: aUser, key: "home_city", value: "ارومیه", confirmedAt: now(), updatedAt: now() });
  const [row] = await h.db.select().from(goals).where(eq(goals.id, goalId));
  return { w, llm, a, b, goalId, aUser, aGoal: row! };
}

test("B cannot read A's goal, alerts or conversation through any read route", async () => {
  const { b, goalId } = await scene();
  for (const path of [`/api/goals/${goalId}`, "/api/goals", "/api/activity", "/api/state"]) {
    const res = await b.call(path);
    const text = await res.text();
    expect([200, 404]).toContain(res.status);
    for (const leak of LEAKS) expect(text).not.toContain(leak);
    if (path === "/api/goals/" + goalId) expect(res.status).toBe(404);
  }
  const s = await (await b.call("/api/state")).json() as any;
  expect(s.goals).toEqual([]);
  expect(s.unreadAlerts).toBe(0);
  expect(s.transcript).toEqual([]);
  expect(s.cards).toBeNull();
});

test("B cannot change A's goal: pause, resume, cancel, propose and approve all fail and nothing changes", async () => {
  const { b, goalId, aGoal } = await scene();
  const attempts: [string, unknown][] = [
    [`/api/goals/${goalId}/pause`, {}], [`/api/goals/${goalId}/resume`, {}], [`/api/goals/${goalId}/cancel`, {}],
    [`/api/goals/${goalId}/propose`, { budget: "۱۰ میلیون" }], [`/api/goals/${goalId}/propose`, { stars: 5 }],
  ];
  for (const [path, body] of attempts) {
    const res = await b.call(path, post(body));
    expect([404, 409]).toContain(res.status);
    expect(await res.text()).not.toContain(SECRET_WORD);
  }
  expect((await b.call("/api/approval", post({ decision: "approve", goalId }))).status).toBe(409);
  expect((await b.call("/api/approval", post({ decision: "reject", goalId }))).status).toBe(409);
  const [after] = await h.db.select().from(goals).where(eq(goals.id, goalId));
  expect(after).toEqual(aGoal); // every column, including status, constraints, proposals and next check
});

test("B marking alerts as read does not touch A's alerts", async () => {
  const { a, b, aUser } = await scene();
  expect((await (await a.call("/api/state")).json() as any).unreadAlerts).toBe(1);
  const r = await (await b.call("/api/notifications/read", post())).json() as any;
  expect(r.unreadAlerts).toBe(0);
  expect((await (await a.call("/api/state")).json() as any).unreadAlerts).toBe(1);
  expect((await h.db.select().from(notifications).where(eq(notifications.userId, aUser)))[0]!.deliveryStatus).toBe("stored");
});

test("B resetting its own session does not reset or erase A's conversation", async () => {
  const { a, b } = await scene();
  const before = await (await a.call("/api/state")).json() as any;
  expect(before.transcript.length).toBeGreaterThan(0);
  await b.call("/api/reset", post());
  const after = await (await a.call("/api/state")).json() as any;
  expect(after.transcript).toEqual(before.transcript);
  expect(after.goals.length).toBe(1);
});

test("guessed ids never reach A's goal: neighbours, zero, negative, huge and malformed ids", async () => {
  const { b, goalId } = await scene();
  const ids = [goalId - 1, goalId + 1, goalId + 100, 0, -1, 99_999_999_999, "abc", "1e3", `${goalId}.5`, `${goalId}%20`, "NaN"];
  for (const id of ids) {
    for (const [path, init] of [[`/api/goals/${id}`, {}], [`/api/goals/${id}/pause`, post()], [`/api/goals/${id}/cancel`, post()], [`/api/goals/${id}/propose`, post({ budget: "۱ میلیون" })]] as const) {
      const res = await b.call(path, init);
      expect([400, 404, 409]).toContain(res.status);
      expect(await res.text()).not.toContain(SECRET_WORD);
    }
  }
});

test("the LLM request built for B contains nothing of A's messages, goal, alerts or preferences", async () => {
  const { llm, b } = await scene();
  const before = llm.requests.length;
  await b.chat("سلام");
  const sent = JSON.stringify(llm.requests.slice(before));
  expect(llm.requests.length).toBeGreaterThan(before);
  for (const leak of LEAKS) expect(sent).not.toContain(leak);
});

test("A's data is still intact and complete after all of B's activity", async () => {
  const { a, b, goalId } = await scene();
  await b.chat("سلام");
  await b.call("/api/reset", post());
  const g = await (await a.call(`/api/goals/${goalId}`)).json() as any;
  expect(g.goal).toMatchObject({ id: goalId, status: "active" });
  const [msgRows] = [await h.db.select().from(messages)];
  expect(msgRows.some((m) => m.content.includes(SECRET_WORD))).toBe(true);
});

test("positive control: the markers do show up for A, so the checks above can fail", async () => {
  const { llm, a } = await scene();
  const st = JSON.stringify(await (await a.call("/api/state")).json());
  expect(st).toContain(SECRET_WORD);
  await a.call("/api/reset", post()); // a new session reloads A's stored preferences
  expect(JSON.stringify(llm.requests)).toContain(SECRET_WORD); // A's goal reached A's own prompts while A chatted
  const before = llm.requests.length;
  await a.chat("سلام");
  expect(JSON.stringify(llm.requests.slice(before))).toContain("ارومیه"); // and A's preference reaches A's next prompt
});
