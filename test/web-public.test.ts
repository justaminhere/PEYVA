/** Public MVP mode: visitor isolation, signed cookies, host guard, quotas and goal caps (real PostgreSQL). */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { DbHandle } from "../src/db/client.ts";
import type { LlmResponse } from "../src/llm/types.ts";
import { goals, goalChecks, messages, notifications, preferences, users } from "../src/db/schema.ts";
import { DailyCounter, VisitorIds, VisitorPool } from "../src/web/public.ts";
import { AgentHost } from "../src/web/host.ts";
import { ScriptedStreamingLlm, call, say, tools } from "./support/scripted-llm.ts";
import { PUBLIC_HOST, publicWebApp } from "./support/web.ts";
import { freshDb } from "./support/pg.ts";

let h: DbHandle & { url: string };
const now = () => new Date("2026-11-20T10:00:00Z");
beforeAll(async () => { h = await freshDb(); });
afterAll(() => h.close());
beforeEach(async () => { for (const t of [notifications, goalChecks, goals, preferences, messages]) await h.db.delete(t); });

const TEXT = "سفر ۳ شبه تهران به کیش ۱۹ آذر ۱۴۰۵، یک نفر، یک اتاق، زیر ۳۰ میلیون؛ اگه پیدا شد خبرم کن";
const goalCall = (budgetText = "۳۰ میلیون") => tools(call("update_trip_goal", { intent: "trip", origin: "تهران", destination: "کیش",
  departureDate: { text: "۱۹ آذر ۱۴۰۵" }, nights: 3, adults: 1, rooms: 1, budgetText, monitoringRequested: true }));
const draftScript = (budgetText?: string) => [goalCall(budgetText), tools(call("start_monitoring", {})), say("تأیید می‌کنی؟")];

test("each visitor gets a signed HttpOnly cookie and sees only their own goals, memory and conversation", async () => {
  const w = await publicWebApp(h, new ScriptedStreamingLlm(draftScript()), now);
  const a = w.browser(), b = w.browser("198.51.100.9");
  const st = (await a.chat(TEXT)).of("state")[0];
  const id = st.pending.goalId;
  expect(a.cookie).toMatch(/^peyva_v=v_[A-Za-z0-9_-]{22}\./);

  const first = await b.call("/api/state");
  const setCookie = first.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Lax");
  const bState = await first.json() as any;
  expect(bState.goals).toEqual([]);
  expect(bState.transcript).toEqual([]);
  expect(bState.userId).not.toBe((await (await a.call("/api/state")).json() as any).userId);
  expect(bState.limitsFa).toContain("نسخهٔ آزمایشی عمومی");

  expect((await b.call(`/api/goals/${id}`)).status).toBe(404); // another visitor's goal reads as "not found"
  expect((await b.call(`/api/goals/${id}/cancel`, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await b.call("/api/approval", { method: "POST", body: JSON.stringify({ decision: "approve", goalId: id }) })).status).toBe(409);
  const aGoals = (await (await a.call("/api/goals")).json() as any).goals;
  expect(aGoals).toMatchObject([{ id, status: "draft" }]);
});

test("a forged or tampered cookie is ignored: the request gets a new, empty visitor", async () => {
  const w = await publicWebApp(h, new ScriptedStreamingLlm(draftScript()), now);
  const a = w.browser();
  await a.chat(TEXT);
  const realId = (await (await a.call("/api/state")).json() as any).userId as string;
  const forger = w.browser("198.51.100.20");
  forger.cookie = `peyva_v=${realId}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  const st = await (await forger.call("/api/state")).json() as any;
  expect(st.userId).not.toBe(realId);
  expect(st.goals).toEqual([]);
  const ids = new VisitorIds("x".repeat(32));
  const v = ids.newId();
  expect(ids.verify(ids.sign(v))).toBe(v);
  expect(ids.verify(`${v}.${ids.sign(v).split(".")[1]!.slice(0, -1)}A`)).toBeNull();
  expect(new VisitorIds("y".repeat(32)).verify(ids.sign(v))).toBeNull(); // another server's key
  expect(() => new VisitorIds("short")).toThrow();
});

test("only the configured public host is served; the platform health check works with any Host", async () => {
  const w = await publicWebApp(h, new ScriptedStreamingLlm([]), now);
  const evil = await w.app.fetch(new Request("https://evil.example/api/state", { headers: { host: "evil.example" } }));
  expect(evil.status).toBe(403);
  const health = await w.app.fetch(new Request("http://10.0.0.5:10000/api/health", { headers: { host: "10.0.0.5:10000" } }));
  expect(health.status).toBe(200);
  const cross = await w.browser().call("/api/reset", { method: "POST", body: "{}", headers: { origin: "https://evil.example" } });
  expect(cross.status).toBe(403);
  expect(PUBLIC_HOST).toBe("peyva.example.app");
});

test("daily turn quota: refused before any LLM call, with a Persian reason; other visitors are unaffected", async () => {
  const llm = new ScriptedStreamingLlm([say("سلام!"), say("سلام دوباره!")]);
  const w = await publicWebApp(h, llm, now, { turnsPerVisitorPerDay: 1 });
  const a = w.browser(), b = w.browser("198.51.100.30");
  expect((await a.chat("سلام")).of("reply")[0].text).toBe("سلام!");
  const refused = await a.chat("دوباره سلام");
  expect(refused.res.status).toBe(429);
  expect((await refused.res.json() as any).errorFa).toContain("سهم امروزت");
  expect(llm.requests.length).toBe(1);
  expect((await b.chat("سلام")).of("reply")[0].text).toBe("سلام دوباره!");
});

test("whole-site token budget: once used up, every visitor's turn is refused until the next UTC day", async () => {
  let t = new Date("2026-11-20T10:00:00Z");
  const llm = new ScriptedStreamingLlm([{ ...say("باشه"), usage: { prompt: 900, completion: 200 } } as LlmResponse, say("فردا")]);
  const w = await publicWebApp(h, llm, () => t, { tokensPerDay: 1_000 });
  const a = w.browser(), b = w.browser("198.51.100.40");
  await a.chat("سلام");
  expect(w.quotas.tokensUsedToday()).toBe(1_100);
  const refused = await b.chat("سلام");
  expect(refused.res.status).toBe(429);
  expect((await refused.res.json() as any).errorFa).toContain("سهمیهٔ روزانهٔ مدل زبانی");
  t = new Date("2026-11-21T00:01:00Z");
  expect((await b.chat("سلام")).of("reply")[0].text).toBe("فردا");
});

test("concurrency cap: a turn slot is released even when the turn fails", () => {
  return (async () => {
    const w = await publicWebApp(h, new ScriptedStreamingLlm([]), now, { maxConcurrentTurns: 1 });
    const one = w.quotas.beginTurn("v_a");
    expect(one.ok).toBe(true);
    const two = w.quotas.beginTurn("v_b");
    expect(two).toMatchObject({ ok: false, status: 503 });
    if (one.ok) { one.done(0); one.done(0); } // idempotent
    expect(w.quotas.beginTurn("v_b").ok).toBe(true);
    // a scripted LLM with no steps throws inside the turn; the slot must come back
    const w2 = await publicWebApp(h, new ScriptedStreamingLlm([]), now, { maxConcurrentTurns: 1 });
    const v = w2.browser();
    const r = await v.chat("سلام");
    expect(r.of("done").length).toBe(1);
    expect(w2.quotas.beginTurn("v_x").ok).toBe(true);
  })();
});

test("manual search quota on /api/compare", async () => {
  const w = await publicWebApp(h, new ScriptedStreamingLlm([goalCall(), say("آماده")]), now, { searchesPerVisitorPerDay: 1 });
  const a = w.browser();
  await a.chat(TEXT);
  expect((await a.call("/api/compare", { method: "POST", body: "{}" })).status).toBe(200);
  const refused = await a.call("/api/compare", { method: "POST", body: "{}" });
  expect(refused.status).toBe(429);
  expect((await refused.json() as any).errorFa).toContain("جست‌وجوی دستی");
  const after = w.provider.calls.length;
  await a.call("/api/compare", { method: "POST", body: "{}" });
  expect(w.provider.calls.length).toBe(after); // refused searches never reach the provider
});

test("active goal cap per visitor: the second approval is refused in Persian and the goal stays a draft", async () => {
  const w = await publicWebApp(h, new ScriptedStreamingLlm([...draftScript(), ...draftScript("۲۵ میلیون")]), now, { maxActiveGoalsPerVisitor: 1 });
  const a = w.browser();
  const first = (await a.chat(TEXT)).of("state")[0].pending.goalId;
  expect((await (await a.call("/api/approval", { method: "POST", body: JSON.stringify({ decision: "approve", goalId: first }) })).json() as any).reply).toContain("پیگیری فعال شد");
  const second = (await a.chat("بودجه رو ۲۵ میلیون کن و اونم پیگیری کن")).of("state")[0].pending?.goalId;
  expect(second).toBeGreaterThan(first);
  const r = await (await a.call("/api/approval", { method: "POST", body: JSON.stringify({ decision: "approve", goalId: second }) })).json() as any;
  expect(r.reply).toContain("حداکثر ۱ پیگیری فعال همزمان");
  const rows = (await (await a.call("/api/goals")).json() as any).goals;
  expect(rows.find((g: any) => g.id === second)).toMatchObject({ status: "draft" });
  expect(rows.find((g: any) => g.id === first)).toMatchObject({ status: "active" });
  // pausing and resuming the first one is allowed again only while under the cap
  await a.call(`/api/goals/${first}/pause`, { method: "POST", body: "{}" });
  expect((await w.goals.approve(rows.find((g: any) => g.id === second) && (await (await a.call("/api/state")).json() as any).userId, second,
    (await h.db.select().from(goals)).find((g) => g.id === second)!.constraintsHash, now())).ok).toBe(true);
  const resume = await a.call(`/api/goals/${first}/resume`, { method: "POST", body: "{}" });
  expect(resume.status).toBe(409);
  expect((await resume.json() as any).errorFa).toContain("حداکثر ۱ پیگیری");
});

test("new visitors per IP per day are capped (cookie-clearing loops)", async () => {
  const w = await publicWebApp(h, new ScriptedStreamingLlm([]), now, { newVisitorsPerIpPerDay: 2 });
  for (let i = 0; i < 2; i++) expect((await w.browser("192.0.2.1").call("/api/state")).status).toBe(200);
  const third = await w.browser("192.0.2.1").call("/api/state");
  expect(third.status).toBe(429);
  expect((await third.json() as any).errorFa).toContain("بازدیدکنندهٔ تازه");
  // the client cannot dodge it by sending its own X-Forwarded-For: only the last (proxy-added) entry counts
  const spoof = await w.browser("192.0.2.1").call("/api/state", { headers: { "x-forwarded-for": "1.2.3.4, 192.0.2.1" } });
  expect(spoof.status).toBe(429);
  expect((await w.browser("192.0.2.2").call("/api/state")).status).toBe(200);
});

test("evicted visitor sessions resume their conversation from PostgreSQL", async () => {
  const w = await publicWebApp(h, new ScriptedStreamingLlm(draftScript()), now);
  const a = w.browser();
  await a.chat(TEXT);
  const before = await (await a.call("/api/state")).json() as any;
  const others = Array.from({ length: 205 }, (_, i) => `v_${String(i).padStart(22, "0")}`);
  await h.db.insert(users).values(others.map((id) => ({ id }))).onConflictDoNothing();
  for (const id of others) w.pool.get(id); // pushes the visitor out (max 200)
  const after = await (await a.call("/api/state")).json() as any;
  expect(after.userId).toBe(before.userId);
  expect(after.transcript.map((m: any) => m.text)).toEqual(before.transcript.map((m: any) => m.text));
  expect(after.trip.ready).toBe(true);
});

test("VisitorPool keeps recent visitors and drops idle ones; DailyCounter rolls over at UTC midnight", () => {
  let t = 0;
  const made: string[] = [];
  const pool = new VisitorPool((id) => { made.push(id); return new AgentHost(async () => ({}) as never); }, 2, 1_000, () => t);
  pool.get("a"); pool.get("b"); pool.get("a"); pool.get("c"); // b is least recent
  expect(pool.size).toBe(2);
  pool.get("a");
  expect(made).toEqual(["a", "b", "c"]);
  t = 5_000; pool.get("a");
  expect(made).toEqual(["a", "b", "c", "a"]); // idle: recreated (and would resume from the database)
  let d = new Date("2026-11-20T23:59:00Z");
  const c = new DailyCounter(() => d);
  c.add("x", 3);
  expect(c.get("x")).toBe(3);
  d = new Date("2026-11-21T00:00:01Z");
  expect(c.get("x")).toBe(0);
});
