import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { DbHandle } from "../src/db/client.ts";
import { goals, goalChecks, messages, notifications, preferences } from "../src/db/schema.ts";
import { localOnly } from "../src/web/app.ts";
import { Hono } from "hono";
import { ScriptedLlm, ScriptedStreamingLlm, call, say, tools } from "./support/scripted-llm.ts";
import { HOST, ORIGIN, webApp } from "./support/web.ts";
import { freshDb } from "./support/pg.ts";

let h: DbHandle & { url: string };
const now = () => new Date("2026-11-20T10:00:00Z");
beforeAll(async () => { h = await freshDb(); });
afterAll(() => h.close());
beforeEach(async () => { for (const t of [notifications, goalChecks, goals, preferences, messages]) await h.db.delete(t); });

const TEXT = "سفر ۳ شبه تهران به کیش ۱۹ آذر ۱۴۰۵، یک نفر، یک اتاق، زیر ۳۰ میلیون؛ اگه پیدا شد خبرم کن";
const goalCall = tools(call("update_trip_goal", { intent: "trip", origin: "تهران", destination: "کیش", departureDate: { text: "۱۹ آذر ۱۴۰۵" },
  nights: 3, adults: 1, rooms: 1, budgetText: "۳۰ میلیون", monitoringRequested: true }));

test("chat streams real progress: LLM calls, live text, tool results, cards from the comparison engine, then the reply and DB state", async () => {
  const llm = new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("گزینهٔ ۱ با ۲۵٬۱۱۴٬۳۰۰ تومان در بودجه است.")]);
  const w = await webApp(h, llm, now);
  const r = await w.chat(TEXT);
  expect(r.res.headers.get("content-type")).toContain("text/event-stream");
  const order = r.events.map((e) => e.event).filter((e, i, a) => e !== a[i - 1]);
  expect(order).toEqual(["accepted", "llm", "tool_start", "tool_done", "llm", "tool_start", "tool_done", "llm", "delta", "cards", "reply", "state", "done"]);
  expect(r.of("delta").map((d) => d.text).join("")).toBe("گزینهٔ ۱ با ۲۵٬۱۱۴٬۳۰۰ تومان در بودجه است.");
  const searches = r.of("tool_done")[0].events.filter((e: any) => e.type === "search");
  expect(searches.map((e: any) => e.textFa)).toEqual([expect.stringContaining("🔎 پرواز"), expect.stringContaining("🔎 پرواز"), expect.stringContaining("🔎 هتل")]);
  expect(w.provider.calls).toEqual(["F:THR-KIH-2026-12-10", "F:KIH-THR-2026-12-13", "H:کیش-2026-12-10-2026-12-13"]);
  const cards = r.of("cards")[0];
  expect(cards.candidates[0]).toMatchObject({ titleFa: "۱۹ آذر ۱۴۰۵ تا ۲۲ آذر ۱۴۰۵", status: "complete" });
  expect(cards.candidates[0].options[0]).toMatchObject({ totalToman: 25_114_300, totalFa: "۲۵٬۱۱۴٬۳۰۰ تومان", withinBudget: true });
  expect(cards.candidates[0].options[0].outbound.flightNumbers).toBe("ZV 4030");
  const reply = r.of("reply")[0];
  expect(reply.text).toBe("گزینهٔ ۱ با ۲۵٬۱۱۴٬۳۰۰ تومان در بودجه است."); // the LLM's words, unchanged
  expect(reply.question).toContain("با همین مشخصات پیگیری را فعال کنم؟"); // the app's question, separately
  const state = r.of("state")[0];
  expect(state.pending).toMatchObject({ kind: "goal", summaryFa: expect.stringContaining("۳۰٬۰۰۰٬۰۰۰") });
  expect(JSON.stringify(state)).not.toContain("hash"); // the approval hash never leaves the server
  expect(state.goals).toMatchObject([{ status: "draft", statusFa: "پیش‌نویس (منتظر تأیید)" }]);
});

test("approval button: activates only the goal that is pending, the reply comes from the DB row, stale clicks are refused", async () => {
  const w = await webApp(h, new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید می‌کنی؟")]), now);
  const st = (await w.chat(TEXT)).of("state")[0];
  const id = st.pending.goalId;
  const stale = await w.call("/api/approval", { method: "POST", body: JSON.stringify({ decision: "approve", goalId: id + 1 }) });
  expect(stale.status).toBe(409);
  const ok = await w.call("/api/approval", { method: "POST", body: JSON.stringify({ decision: "approve", goalId: id }) });
  const body = await ok.json() as any;
  expect(body.reply).toContain("پیگیری فعال شد");
  expect(body.reply).toContain("به وقت تهران");
  expect(body.pending).toBeNull();
  expect(body.goals[0]).toMatchObject({ id, status: "active", statusFa: "فعال", nextCheckFa: expect.stringContaining("۱۴۰۵") });
  const dbRow = await w.ctx.goals.get("amin", id);
  expect(dbRow).toMatchObject({ status: "active", approvedConstraintsHash: dbRow!.constraintsHash });
  expect((await w.call("/api/approval", { method: "POST", body: JSON.stringify({ decision: "approve", goalId: id }) })).status).toBe(409); // nothing pending now
  const g = await (await w.call(`/api/goals/${id}`)).json() as any;
  expect(g.goal).toMatchObject({ lastSuccess: null, totalChecksFa: "۰" });
  const paused = await (await w.call(`/api/goals/${id}/pause`, { method: "POST", body: "{}" })).json() as any;
  expect(paused.goal.status).toBe("paused");
  expect((await w.call(`/api/goals/99999/cancel`, { method: "POST", body: "{}" })).status).toBe(404);
});

test("reject button cancels the draft; typed 'بله' still works and never reaches the LLM", async () => {
  const llm = new ScriptedLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید؟"), goalCall, tools(call("start_monitoring", {})), say("تأیید؟")]);
  const w = await webApp(h, llm, now);
  let st = (await w.chat(TEXT)).of("state")[0];
  const rej = await (await w.call("/api/approval", { method: "POST", body: JSON.stringify({ decision: "reject", goalId: st.pending.goalId }) })).json() as any;
  expect(rej.reply).toContain("پیگیری فعال نشد");
  expect((await w.ctx.goals.get("amin", st.pending.goalId))!.status).toBe("canceled");
  st = (await w.chat(TEXT)).of("state")[0];
  const before = llm.requests.length;
  const yes = await w.chat("بله");
  expect(llm.requests.length).toBe(before);
  expect(yes.of("reply")[0]).toMatchObject({ source: "approval", text: expect.stringContaining("پیگیری فعال شد") });
  expect(yes.of("state")[0].goals.find((g: any) => g.id === st.pending.goalId).status).toBe("active");
});

test("state survives a page reload: transcript from PostgreSQL, current cards and pending approval", async () => {
  const w = await webApp(h, new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید؟")]), now);
  await w.chat(TEXT);
  const s = await (await w.call("/api/state")).json() as any;
  expect(s.transcript.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  expect(s.transcript[0].text).toBe(TEXT);
  expect(s.cards.candidates[0].options[0].totalToman).toBe(25_114_300);
  expect(s.pending.kind).toBe("goal");
  await w.call("/api/reset", { method: "POST", body: "{}" });
  const fresh = await (await w.call("/api/state")).json() as any;
  expect(fresh).toMatchObject({ transcript: [], cards: null, pending: null });
  expect(fresh.goals).toHaveLength(1); // goals are in the database, not in the session
});

test("LLM failure is reported as an error reply, never as a made-up answer", async () => {
  const w = await webApp(h, new ScriptedLlm([{ ok: false, cause: "rate_limit", message: "Please try again in 8m9.888s (TPD)" }]), now);
  const r = await w.chat("سلام");
  expect(r.of("reply")[0]).toMatchObject({ source: "llm", llmError: expect.stringContaining("rate_limit") });
  expect(r.of("reply")[0].text).toContain("سهمیهٔ روزانه");
  expect(r.of("delta")).toEqual([]);
});

test("turns are serialized: two concurrent messages never run on the session at the same time", async () => {
  let active = 0, maxActive = 0;
  const slow = { label: "TEST-ONLY", async complete() { active++; maxActive = Math.max(maxActive, active); await Bun.sleep(50); active--; return say("باشه"); } };
  const w = await webApp(h, slow, now);
  await Promise.all([w.chat("یک"), w.chat("دو"), w.chat("سه")]);
  expect(maxActive).toBe(1);
});

test("loopback guard: wrong Host (DNS rebinding), foreign Origin, cross-site fetch and non-JSON writes are refused; no CORS headers", async () => {
  const w = await webApp(h, new ScriptedLlm([]), now);
  const raw = (path: string, headers: Record<string, string>, method = "GET", body?: string) => w.app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }));
  expect((await raw("/api/state", { host: "evil.example:4317" })).status).toBe(403);
  expect((await raw("/api/state", { host: "192.168.1.5:4317" })).status).toBe(403);
  expect((await raw("/api/chat", { host: HOST, origin: "https://evil.example", "content-type": "application/json" }, "POST", '{"text":"x"}')).status).toBe(403);
  expect((await raw("/api/chat", { host: HOST, origin: ORIGIN, "sec-fetch-site": "cross-site", "content-type": "application/json" }, "POST", '{"text":"x"}')).status).toBe(403);
  expect((await raw("/api/chat", { host: HOST, origin: ORIGIN, "content-type": "text/plain" }, "POST", '{"text":"x"}')).status).toBe(415);
  expect((await raw("/api/chat", { host: HOST, origin: ORIGIN, "content-type": "application/json" }, "POST", '{"text":""}')).status).toBe(400);
  const ok = await raw("/api/health", { host: HOST });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("access-control-allow-origin")).toBeNull();
  expect(ok.headers.get("x-frame-options")).toBe("DENY");
});

test("the guard is generic middleware (also used for the static UI)", async () => {
  const a = new Hono().use("*", localOnly(["127.0.0.1:1"], ["http://127.0.0.1:1"])).get("/", (c) => c.text("ui"));
  expect((await a.fetch(new Request("http://x/", { headers: { host: "127.0.0.1:1" } }))).status).toBe(200);
  expect((await a.fetch(new Request("http://x/", { headers: { host: "attacker.test" } }))).status).toBe(403);
});
