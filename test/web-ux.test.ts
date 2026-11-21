/** Phase 4B: goal brief edits, re-check, change proposals with diff, activity/alerts, comparison view model. Real PostgreSQL, recorded MrBilit data. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { DbHandle } from "../src/db/client.ts";
import { conversations, goals, goalChecks, messages, notifications, preferences } from "../src/db/schema.ts";
import { ScriptedLlm, ScriptedStreamingLlm, call, say, tools } from "./support/scripted-llm.ts";
import { webApp } from "./support/web.ts";
import { freshDb } from "./support/pg.ts";
import { comparisonCards } from "../src/render/cards.ts";
import { diffSummaries } from "../src/web/views.ts";

let h: DbHandle & { url: string };
let clock = new Date("2026-11-20T10:00:00Z");
const now = () => clock;
beforeAll(async () => { h = await freshDb(); });
afterAll(() => h.close());
beforeEach(async () => { clock = new Date("2026-11-20T10:00:00Z"); for (const t of [notifications, goalChecks, goals, preferences, messages, conversations]) await h.db.delete(t); });

const post = (w: Awaited<ReturnType<typeof webApp>>, path: string, body: unknown) => w.call(path, { method: "POST", body: JSON.stringify(body) });
const TEXT = "سفر ۳ شبه تهران به کیش ۱۹ آذر ۱۴۰۵، یک نفر، یک اتاق، زیر ۳۰ میلیون";
const goalCall = tools(call("update_trip_goal", { intent: "trip", origin: "تهران", destination: "کیش", departureDate: { text: "۱۹ آذر ۱۴۰۵" }, nights: 3, adults: 1, rooms: 1, budgetText: "۳۰ میلیون" }));
const field = (st: any, key: string) => st.trip.fields.find((f: any) => f.key === key);

test("the brief shows what is understood and what is missing; the user fills gaps without an LLM call", async () => {
  const llm = new ScriptedLlm([tools(call("update_trip_goal", { destination: "کیش", nights: 3 })), say("از کجا؟")]);
  const w = await webApp(h, llm, now);
  let st = (await w.chat("یه سفر سه شبه به کیش")).of("state")[0];
  expect(st.trip).toMatchObject({ empty: false, ready: false, results: "none" });
  expect(field(st, "destination")).toMatchObject({ valueFa: "کیش", missing: false });
  expect(field(st, "origin")).toMatchObject({ valueFa: null, missing: true });
  expect(st.trip.missingFa).toEqual(["مبدأ", "تاریخ رفت", "تعداد مسافر"]);
  const calls = llm.requests.length;
  for (const [f, v] of [["origin", "تهران"], ["dates", "۱۹ آذر ۱۴۰۵"], ["travellers", 1], ["budget", "۳۰ میلیون"]] as const) {
    const r = await post(w, "/api/trip", { field: f, value: v });
    expect(r.status).toBe(200);
  }
  st = await (await w.call("/api/state")).json();
  expect(llm.requests.length).toBe(calls); // no LLM request for any edit
  expect(st.trip).toMatchObject({ ready: true, missingFa: [], conflictsFa: [], results: "none" });
  expect(field(st, "dates").valueFa).toBe("۱۹ آذر ۱۴۰۵ تا ۲۲ آذر ۱۴۰۵"); // return follows the nights
  expect(field(st, "budget").valueFa).toBe("تا ۳۰٬۰۰۰٬۰۰۰ تومان کل سفر");
  expect(st.transcript.filter((m: any) => m.text.startsWith("✎")).map((m: any) => m.text)).toEqual(["✎ مبدأ: — ← تهران", "✎ تاریخ: — ← ۱۹ آذر ۱۴۰۵ تا ۲۲ آذر ۱۴۰۵", "✎ مسافر: — ← ۱ بزرگسال · ۱ اتاق", "✎ بودجه: — ← تا ۳۰٬۰۰۰٬۰۰۰ تومان کل سفر"]);
});

test("edits keep unrelated conditions, reject invalid values without changing anything, and keep dates consistent", async () => {
  const w = await webApp(h, new ScriptedStreamingLlm([goalCall, say("گزینه‌ها آماده است.")]), now);
  const before = (await w.chat(TEXT)).of("state")[0];
  expect(before.trip.results).toBe("current");
  const bad = [
    [{ field: "destination", value: "آتلانتیس" }, "نمی‌شناسم"], [{ field: "dates", value: "فردای کذایی" }, "نتوانستم بخوانم"],
    [{ field: "dates", value: "۱ آبان ۱۴۰۵" }, "گذشته است"], [{ field: "budget", value: "خیلی" }, "نتوانستم بخوانم"],
  ] as const;
  for (const [body, msg] of bad) {
    const r = await post(w, "/api/trip", body);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).errorFa).toContain(msg);
  }
  expect((await post(w, "/api/trip", { field: "nights", value: 99 })).status).toBe(400); // schema bound
  let st = await (await w.call("/api/state")).json() as any;
  expect(st.trip.fields).toEqual(before.trip.fields); // nothing changed by the rejected edits
  const r = await (await post(w, "/api/trip", { field: "budget", value: "۲۸ میلیون" })).json() as any;
  expect(r.changeFa).toBe("بودجه: تا ۳۰٬۰۰۰٬۰۰۰ تومان کل سفر ← تا ۲۸٬۰۰۰٬۰۰۰ تومان کل سفر");
  for (const k of ["origin", "destination", "dates", "nights", "travellers", "stars"]) expect(field(r, k)).toEqual(field(before, k));
  expect(r.trip.results).toBe("outdated"); // the shown results were for 30M
  st = await (await post(w, "/api/trip", { field: "nights", value: 4 })).json();
  expect(field(st, "dates").valueFa).toBe("۱۹ آذر ۱۴۰۵ تا ۲۳ آذر ۱۴۰۵");
  expect(st.trip.conflictsFa).toEqual([]);
  st = await (await post(w, "/api/trip", { field: "stars", value: 4 })).json();
  expect(field(st, "stars").valueFa).toBe("حداقل ۴ ستاره");
  st = await (await post(w, "/api/trip", { field: "stars", value: 0 })).json();
  expect(field(st, "stars").valueFa).toBeNull();
});

test("an assumption (the year) is confirmed with one click instead of a chat round trip", async () => {
  const w = await webApp(h, new ScriptedLlm([tools(call("update_trip_goal", { destination: "کیش", departureDate: { text: "۱۹ آذر" } })), say("۱۴۰۵؟")]), now);
  let st = (await w.chat("۱۹ آذر کیش")).of("state")[0];
  expect(st.trip.assumptionsFa[0]).toContain("۱۴۰۵");
  st = await (await post(w, "/api/trip", { field: "confirmAssumptions", value: true })).json();
  expect(st.trip.assumptionsFa).toEqual([]);
});

test("re-check after an edit runs the real (recorded) searches and the deterministic comparison, without the LLM", async () => {
  const llm = new ScriptedStreamingLlm([goalCall, say("گزینه‌ها آماده است.")]);
  const w = await webApp(h, llm, now);
  await w.chat(TEXT);
  await post(w, "/api/trip", { field: "stars", value: 4 });
  const calls = llm.requests.length;
  const r = await (await post(w, "/api/compare", {})).json() as any;
  expect(llm.requests.length).toBe(calls);
  expect(r.trip.results).toBe("current");
  expect(r.cards.candidates[0].options[0].totalFa).toBe("۲۸٬۶۸۱٬۳۰۰ تومان"); // the 4★ package, from the engine
  expect(r.events.map((e: any) => e.textFa).join(" ")).toContain("مقایسهٔ قطعی");
  await post(w, "/api/reset", {});
  expect((await post(w, "/api/compare", {})).status).toBe(409); // nothing to compare in a new conversation
});

test("comparison view model: shared flights shown once, why each option fits, freshness, best date across a window", async () => {
  const w = await webApp(h, new ScriptedStreamingLlm([goalCall, say("…")]), now);
  const cards = (await w.chat(TEXT)).of("cards")[0];
  const c = cards.candidates[0];
  expect(c.sharedFlights.outbound.flightNumbers).toBe("ZV 4030");
  expect(c.options[0].matchFa[0]).toBe("در بودجه؛ ۴٬۸۸۵٬۷۰۰ تومان کمتر از سقف"); // 30,000,000 − 25,114,300
  expect(c).toMatchObject({ fresh: true, statusFa: "کامل", cheapestTotalFa: "۲۵٬۱۱۴٬۳۰۰ تومان", cheapestWithinBudget: true });
  expect(cards.bestIndex).toBe(0);
  // 16 minutes later the same results are shown as old, not as current prices
  clock = new Date(clock.getTime() + 16 * 60_000);
  const st = await (await w.call("/api/state")).json() as any;
  expect(st.cards.candidates[0]).toMatchObject({ fresh: false, staleFa: expect.stringContaining("قدیمی‌تر از ۱۵ دقیقه") });
});

test("several candidate dates: one overview with the cheapest per date and the best one marked", async () => {
  const llm = new ScriptedStreamingLlm([tools(call("update_trip_goal", { intent: "trip", origin: "تهران", destination: "کیش", adults: 1, nights: 3, datesFlexible: true,
    dateWindow: { from: { text: "۱۰ دی ۱۴۰۵" }, to: { text: "۲۰ دی ۱۴۰۵" } }, budgetText: "۳۰ میلیون" })), say("…")]);
  const w = await webApp(h, llm, now);
  const cards = (await w.chat("تهران به کیش، سه شب، یک نفر، بین ۱۰ تا ۲۰ دی ۱۴۰۵، هر تاریخی، تا ۳۰ میلیون")).of("cards")[0];
  expect(cards.candidates).toHaveLength(3);
  expect(cards.candidates.map((c: any) => c.titleFa.split(" تا ")[0])).toEqual(["۱۰ دی ۱۴۰۵", "۱۳ دی ۱۴۰۵", "۱۷ دی ۱۴۰۵"]);
  expect(cards.bestIndex).not.toBeNull();
  expect(cards.candidates.every((c: any) => c.cheapestTotalFa)).toBe(true);
});

test("a monitored trip: brief shows it is watched; a change is proposed with a diff; reject keeps it, approve applies it", async () => {
  const w = await webApp(h, new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید؟")]), now);
  const id = (await w.chat(TEXT + "؛ اگه پیدا شد خبرم کن")).of("state")[0].pending.goalId;
  let st = await (await post(w, "/api/approval", { decision: "approve", goalId: id })).json() as any;
  expect(st.activityGoalId).toBe(id);
  expect(st.trip.monitoredBy).toMatchObject({ goalId: id, status: "active" });
  const before = (await w.ctx.goals.get("amin", id))!;
  expect((await post(w, `/api/goals/${id}/propose`, { budget: "هیچ" })).status).toBe(400);
  st = await (await post(w, `/api/goals/${id}/propose`, { budget: "۲۵ میلیون", stars: 3 })).json();
  expect(st.pending).toMatchObject({ kind: "goal", goalId: id, change: true });
  expect(st.pending.diff).toEqual([
    { labelFa: "هتل", beforeFa: "بدون شرط ستاره", afterFa: "حداقل ۳ ستاره" },
    { labelFa: "سقف جمع پرواز رفت و برگشت + هتل", beforeFa: "۳۰٬۰۰۰٬۰۰۰ تومان", afterFa: "۲۵٬۰۰۰٬۰۰۰ تومان" },
  ]);
  expect(JSON.stringify(st.pending)).not.toContain("hash");
  st = await (await post(w, "/api/approval", { decision: "reject", goalId: id })).json();
  expect(st.reply).toContain("با شرایط قبلی ادامه دارد");
  expect((await w.ctx.goals.get("amin", id))!).toMatchObject({ status: "active", constraintsHash: before.constraintsHash, nextCheckAt: before.nextCheckAt, proposedHash: null });
  await post(w, `/api/goals/${id}/propose`, { budget: "۲۵ میلیون" });
  expect((await post(w, `/api/goals/${id}/propose`, { stars: 2 })).status).toBe(200); // replaces its own waiting proposal
  st = await (await post(w, "/api/approval", { decision: "approve", goalId: id })).json();
  expect(st.reply).toContain("شرایط تازه اعمال شد");
  const g = st.goals.find((x: any) => x.id === id);
  expect(g.summaryFa).toContain("حداقل ۲ ستاره");
  expect(g.editable).toEqual({ budgetToman: 30_000_000, minimumHotelStars: 2 });
});

test("activity: the latest match alert and its stored Telegram status per goal; unread until the user opens it", async () => {
  const w = await webApp(h, new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید؟")]), now);
  const id = (await w.chat(TEXT + "؛ اگه پیدا شد خبرم کن")).of("state")[0].pending.goalId;
  await post(w, "/api/approval", { decision: "approve", goalId: id });
  let a = await (await w.call("/api/activity")).json() as any;
  expect(a.goals[0].lastAlert).toBeNull();
  const goal = (await w.ctx.goals.get("amin", id))!;
  await w.ctx.notifications.queueMatch(goal, { key: "k1", totalToman: 25_114_300, provider: "mrbilit", checkedAt: clock.toISOString(),
    details: { departure: "2026-12-10", return: "2026-12-13", nights: 3, outboundFlight: { flightNumbers: ["ZV 4030"], airline: "زاگرس" } } });
  a = await (await w.call("/api/activity")).json();
  expect(a.unreadAlerts).toBe(1);
  expect(a.goals[0].lastAlert).toMatchObject({ unread: true, totalFa: "۲۵٬۱۱۴٬۳۰۰ تومان", telegramFa: null, textFa: expect.stringContaining("ZV 4030") });
  const st = await (await post(w, "/api/notifications/read", {})).json() as any;
  expect(st.unreadAlerts).toBe(0);
  expect(st.goals[0].lastAlert.unread).toBe(false);
});

test("diff of two condition summaries lists only changed lines", () => {
  expect(diffSummaries("الف: ۱\nب: ۲\nج: ۳", "الف: ۱\nب: ۵\nج: ۳")).toEqual([{ labelFa: "ب", beforeFa: "۲", afterFa: "۵" }]);
  expect(diffSummaries("الف: ۱", "الف: ۱")).toEqual([]);
});

test("asking to monitor a trip that is already monitored does not create a second goal", async () => {
  const w = await webApp(h, new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید؟"), tools(call("start_monitoring", {})), say("این سفر از قبل زیر نظر است.")]), now);
  const id = (await w.chat(TEXT + "؛ اگه پیدا شد خبرم کن")).of("state")[0].pending.goalId;
  await post(w, "/api/approval", { decision: "approve", goalId: id });
  const r = await w.chat("اگه ارزون شد خبرم کن");
  const done = r.of("tool_done")[0];
  expect(done).toMatchObject({ name: "start_monitoring", ok: false });
  expect(done.events[0].textFa).toContain("همین شرایط از قبل زیر نظر است");
  expect(r.of("state")[0].pending).toBeNull();
  expect((await w.ctx.goals.list("amin")).length).toBe(1);
});

test("a budget typed in the brief without a unit is Toman (the field is labelled in Toman), not an assumption", async () => {
  const w = await webApp(h, new ScriptedStreamingLlm([goalCall, say("…")]), now);
  await w.chat(TEXT);
  const st = await (await post(w, "/api/trip", { field: "budget", value: "۲۸ میلیون" })).json() as any;
  const s = await (await w.call("/api/state")).json() as any;
  expect(s.goal.budget).toMatchObject({ toman: 28_000_000, assumedUnit: false });
  expect(st.trip.conflictsFa).toEqual([]);
});
