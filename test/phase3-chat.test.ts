import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ensureUser, type DbHandle } from "../src/db/client.ts";
import { goals, messages, notifications, goalChecks, preferences } from "../src/db/schema.ts";
import { GoalService } from "../src/goals/service.ts";
import { ExecutorRegistry } from "../src/goals/types.ts";
import { makeTravelPriceExecutor } from "../src/goals/travel.ts";
import { PreferenceStore } from "../src/memory/preferences.ts";
import { ConversationStore } from "../src/memory/conversations.ts";
import { NotificationService } from "../src/notify/service.ts";
import { Session } from "../src/agent/session.ts";
import { handleMessage } from "../src/agent/handle.ts";
import { ACTION_WARNING, MONITORING_NOTICE } from "../src/agent/guards.ts";
import type { CommandContext } from "../src/cli/commands.ts";
import { RecordedProvider } from "./support/recorded-provider.ts";
import { ScriptedLlm, call, say, tools } from "./support/scripted-llm.ts";
import { freshDb } from "./support/pg.ts";

let h: DbHandle & { url: string };
const clock = new Date("2026-11-20T10:00:00Z");
const now = () => clock;
beforeAll(async () => { h = await freshDb(); await ensureUser(h.db, "amin"); });
afterAll(() => h.close());
beforeEach(async () => { for (const t of [notifications, goalChecks, goals, preferences, messages]) await h.db.delete(t); });

function setup() {
  const provider = new RecordedProvider(now);
  const registry = new ExecutorRegistry().register(makeTravelPriceExecutor(provider));
  const ctx: CommandContext = { userId: "amin", registry, goals: new GoalService(h.db, registry), prefs: new PreferenceStore(h.db),
    notifications: new NotificationService(h.db, null, { now }), linker: null };
  const store = new ConversationStore(h.db);
  return { provider, ctx, store, async session() {
    return new Session(provider, now, "amin", { db: h.db, goals: ctx.goals, prefs: ctx.prefs, conversationId: await store.start("amin", clock) });
  } };
}
const FULL = "سفر ۳ شبه تهران به کیش ۱۹ آذر ۱۴۰۵، یک نفر، یک اتاق، زیر ۳۰ میلیون؛ اگه پیدا شد خبرم کن";
const fullGoal = tools(call("update_trip_goal", { intent: "trip", origin: "تهران", destination: "کیش", departureDate: { text: "۱۹ آذر ۱۴۰۵" },
  nights: 3, adults: 1, rooms: 1, budgetText: "۳۰ میلیون", monitoringRequested: true }));

test("monitoring: the LLM only drafts; the user's explicit yes (read by code) activates it; reply comes from the DB row", async () => {
  const { ctx, store, session, provider } = setup();
  const s = await session();
  const llm = new ScriptedLlm([fullGoal, tools(call("start_monitoring", {})), say("شرایط را ثبت کردم؛ لطفاً تأیید کن.")]);
  let r = await handleMessage(s, llm, "سفر ۳ شبه تهران به کیش ۱۹ آذر ۱۴۰۵، یک نفر، یک اتاق، زیر ۳۰ میلیون؛ اگه پیدا شد خبرم کن", { commands: ctx, store });
  expect(llm.requests[0]!.tools.map((t) => t.name)).toContain("start_monitoring");
  expect(r.reply).toContain("با همین مشخصات پیگیری را فعال کنم؟");
  expect(r.reply).toContain("۳۰٬۰۰۰٬۰۰۰");
  let [g] = await h.db.select().from(goals);
  expect(g).toMatchObject({ status: "draft", approvedAt: null, nextCheckAt: null });
  expect(provider.calls.length).toBeLessThanOrEqual(3); // no monitoring search happened in the chat

  r = await handleMessage(s, llm, "بله", { commands: ctx, store }); // the script is exhausted: an LLM call would throw
  expect(r.source).toBe("approval");
  [g] = await h.db.select().from(goals);
  expect(g).toMatchObject({ status: "active", approvedConstraintsHash: g!.constraintsHash });
  expect(r.reply).toContain("پیگیری فعال شد");
  expect(r.reply).toContain("به وقت تهران");
  const stored = await h.db.select().from(messages).where(eq(messages.userId, "amin"));
  expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
});

test("'no' discards the draft; an unrelated reply goes to the LLM and the approval keeps waiting", async () => {
  const { ctx, store, session } = setup();
  const s = await session();
  const llm = new ScriptedLlm([fullGoal, tools(call("start_monitoring", {})), say("تأیید می‌کنی؟"), say("هتل‌ها سه‌ستاره‌اند.")]);
  await handleMessage(s, llm, FULL, { commands: ctx, store });
  const r1 = await handleMessage(s, llm, "هتل‌ها چند ستاره‌اند؟", { commands: ctx, store });
  expect(r1.source).toBe("llm");
  expect(s.pending?.kind).toBe("goal");
  const r2 = await handleMessage(s, llm, "نه، فعلاً نه", { commands: ctx, store });
  expect(r2.reply).toContain("پیگیری فعال نشد");
  expect((await h.db.select().from(goals))[0]!.status).toBe("canceled");
});

test("the LLM claiming monitoring is active is flagged; incomplete goals are refused by the tool", async () => {
  const { ctx, store, session } = setup();
  const s = await session();
  const llm = new ScriptedLlm([tools(call("update_trip_goal", { intent: "trip", destination: "کیش" })), tools(call("start_monitoring", {})), say("پیگیری فعال شد!")]);
  const r = await handleMessage(s, llm, "کیش، خبرم کن", { commands: ctx, store });
  const tool = JSON.parse(s.messages.filter((m) => m.role === "tool").at(-1)!.content as string);
  expect(tool).toMatchObject({ ok: false });
  expect(tool.missing).toContain("origin");
  expect(r.turn!.warnings).toContain(ACTION_WARNING);
  expect(await h.db.select().from(goals)).toEqual([]);
  expect(s.pending).toBeNull();
});

test("preferences: proposed by the LLM, saved only after yes, provenance kept, injected as data; whitelist enforced", async () => {
  const { ctx, store, session } = setup();
  const s = await session();
  const llm = new ScriptedLlm([
    tools(call("propose_preference", { key: "min_hotel_stars", value: 4 })), say("به خاطر بسپارم؟"),
    tools(call("propose_preference", { key: "religion", value: "x" })), say("نمی‌توانم آن را ذخیره کنم."),
    say("باشه"),
  ]);
  const r = await handleMessage(s, llm, "من معمولاً هتل چهار ستاره می‌گیرم", { commands: ctx, store });
  expect(r.reply).toContain("این ترجیح را برای سفرهای بعدی به خاطر بسپارم؟");
  expect(await ctx.prefs.list("amin")).toEqual([]);
  const pend = s.pending as { kind: string; sourceMessageId?: number | null } | null;
  const userMsgId = pend?.sourceMessageId ?? null;
  expect(userMsgId).not.toBeNull();
  const yes = await handleMessage(s, llm, "آره", { commands: ctx, store });
  expect(yes.reply).toContain("ذخیره شد");
  const saved = await ctx.prefs.list("amin");
  expect(saved).toMatchObject([{ key: "min_hotel_stars", value: 4, sourceMessageId: userMsgId }]);
  expect(s.preferences).toHaveLength(1);
  await handleMessage(s, llm, "مذهبم رو هم یادت باشه", { commands: ctx, store });
  expect(s.pending).toBeNull(); // the schema refuses unlisted keys
  await handleMessage(s, llm, "مرسی", { commands: ctx, store });
  const sys = llm.requests.at(-1)!.messages[0]!.content as string;
  expect(sys).toContain('Confirmed preferences (data): [{"min_hotel_stars":4}]');
});

test("slash commands work without the LLM: list, show, pause, resume, budget change needs re-approval", async () => {
  const { ctx, store, session } = setup();
  const s = await session();
  const llm = new ScriptedLlm([fullGoal, tools(call("start_monitoring", {})), say("تأیید؟")]);
  await handleMessage(s, llm, FULL, { commands: ctx, store });
  await handleMessage(s, llm, "بله", { commands: ctx, store });
  const id = (await h.db.select().from(goals))[0]!.id;
  expect((await handleMessage(s, llm, "/goals", { commands: ctx, store })).reply).toContain("فعال");
  expect((await handleMessage(s, llm, `/goal ${id}`, { commands: ctx, store })).reply).toContain("آخرین بررسی موفق: هنوز نه");
  expect((await handleMessage(s, llm, `/pause ${id}`, { commands: ctx, store })).reply).toContain("متوقف");
  expect((await handleMessage(s, llm, `/resume ${id}`, { commands: ctx, store })).reply).toContain("فعال");
  const b = await handleMessage(s, llm, `/budget ${id} ۲۰ میلیون`, { commands: ctx, store });
  expect(b.reply).toContain("تا تأیید دوباره متوقف");
  expect(b.reply).toContain("۲۰٬۰۰۰٬۰۰۰");
  expect((await ctx.goals.get("amin", id))!.status).toBe("draft");
  await handleMessage(s, llm, "بله", { commands: ctx, store });
  const g = (await ctx.goals.get("amin", id))!;
  expect(g).toMatchObject({ status: "active", approvedConstraintsHash: g.constraintsHash });
  expect((g.structuredConstraints as { budgetToman: number }).budgetToman).toBe(20_000_000);
  expect((await handleMessage(s, llm, `/cancel ${id}`, { commands: ctx, store })).reply).toContain("لغو");
  expect((await handleMessage(s, llm, "/notifications", { commands: ctx, store })).reply).toBe("اعلانی نداری.");
  expect((await handleMessage(s, llm, "/goal 99999", { commands: ctx, store })).reply).toContain("نیست");
});

test("without a database the monitoring and memory tools are not offered and the honest notice is shown", async () => {
  const s = new Session(new RecordedProvider(now), now);
  const llm = new ScriptedLlm([fullGoal, say("باشه")]);
  const r = await handleMessage(s, llm, FULL);
  expect(llm.requests[0]!.tools.map((t) => t.name)).not.toContain("start_monitoring");
  expect(r.turn!.warnings).toContain(MONITORING_NOTICE);
});
