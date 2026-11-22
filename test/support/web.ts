/** TEST-ONLY wiring of the real web app: real PostgreSQL, recorded provider data, scripted (streaming) LLM. */
import { ensureUser, type DbHandle } from "../../src/db/client.ts";
import { GoalService } from "../../src/goals/service.ts";
import { ExecutorRegistry } from "../../src/goals/types.ts";
import { makeTravelPriceExecutor } from "../../src/goals/travel.ts";
import { PreferenceStore } from "../../src/memory/preferences.ts";
import { ConversationStore } from "../../src/memory/conversations.ts";
import { NotificationService } from "../../src/notify/service.ts";
import type { CommandContext } from "../../src/cli/commands.ts";
import type { LlmClient } from "../../src/llm/types.ts";
import { AgentHost } from "../../src/web/host.ts";
import { webSessionFactory } from "../../src/web/session.ts";
import { createApp } from "../../src/web/app.ts";
import { DEFAULT_QUOTAS, Quotas, VisitorIds, VisitorPool, publicVisitor, type QuotaOptions } from "../../src/web/public.ts";
import { readSse } from "../../web/src/sse.ts";
import { RecordedProvider } from "./recorded-provider.ts";

export const HOST = "127.0.0.1:4317";
export const ORIGIN = `http://${HOST}`;

export async function webApp(db: DbHandle, llm: LlmClient, now: () => Date, opts: { resumeMaxAgeMs?: number } = {}) {
  await ensureUser(db.db, "amin");
  const provider = new RecordedProvider(now);
  const registry = new ExecutorRegistry().register(makeTravelPriceExecutor(provider));
  const ctx: CommandContext = { userId: "amin", registry, goals: new GoalService(db.db, registry), prefs: new PreferenceStore(db.db),
    notifications: new NotificationService(db.db, null, { now }), linker: null };
  const store = new ConversationStore(db.db);
  const host = new AgentHost(webSessionFactory({ provider, userId: "amin", store, now, persistence: { db: db.db, goals: ctx.goals, prefs: ctx.prefs }, resumeMaxAgeMs: opts.resumeMaxAgeMs ?? 0 }));
  const app = createApp({ host, llm, ctx, store, allowedHosts: [HOST], allowedOrigins: [ORIGIN], now });
  /** fetch() into the app as a same-origin browser would. */
  const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, {
    ...init, headers: { host: HOST, ...(init.method && init.method !== "GET" ? { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}), ...(init.headers as Record<string, string> ?? {}) },
  }));
  const chat = async (text: string) => {
    const res = await call("/api/chat", { method: "POST", body: JSON.stringify({ text }) });
    const events: { event: string; data: any }[] = [];
    for await (const m of readSse(res.body!)) events.push({ event: m.event, data: JSON.parse(m.data) });
    return { res, events, of: (e: string) => events.filter((x) => x.event === e).map((x) => x.data) };
  };
  return { app, call, chat, ctx, provider, host };
}

export const PUBLIC_HOST = "peyva.example.app";
export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;

/** TEST-ONLY public-MVP wiring (src/web/server.ts with PEYVA_PUBLIC=1): visitor cookies, quotas, goal caps. */
export async function publicWebApp(db: DbHandle, llm: LlmClient, now: () => Date, quotaOverrides: Partial<QuotaOptions> = {}) {
  const provider = new RecordedProvider(now);
  const registry = new ExecutorRegistry().register(makeTravelPriceExecutor(provider));
  const quotas = await Quotas.create({ ...DEFAULT_QUOTAS, ...quotaOverrides }, undefined, now);
  const goals = new GoalService(db.db, registry, { maxActivePerUser: quotas.o.maxActiveGoalsPerVisitor, maxActiveTotal: quotas.o.maxActiveGoalsTotal });
  const prefs = new PreferenceStore(db.db);
  const notifications = new NotificationService(db.db, null, { now });
  const store = new ConversationStore(db.db);
  const persistence = { db: db.db, goals, prefs };
  const pool = new VisitorPool((id) => new AgentHost(webSessionFactory({ provider, userId: id, store, now, persistence, resumeMaxAgeMs: 24 * 3_600_000 })));
  const ids = new VisitorIds("test-secret-test-secret-test-secret-0123");
  const visitor = publicVisitor({ ids, pool, quotas, secureCookie: true,
    ctxFor: async (id) => { await ensureUser(db.db, id); return { userId: id, registry, goals, prefs, notifications, linker: null }; } });
  const app = createApp({ visitor, limits: quotas, llm, ctx: { userId: "unused", registry, goals, prefs, notifications, linker: null }, store,
    allowedHosts: [PUBLIC_HOST], allowedOrigins: [PUBLIC_ORIGIN], now, info: { llm: "test", telegram: false, db: "PostgreSQL", mode: "public" } });
  /** A browser with its own cookie jar (one visitor). */
  const browser = (ip = "203.0.113.7") => {
    let cookie = "";
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await app.fetch(new Request(`${PUBLIC_ORIGIN}${path}`, {
        ...init, headers: { host: PUBLIC_HOST, "x-forwarded-for": `10.0.0.1, ${ip}`, ...(cookie ? { cookie } : {}),
          ...(init.method && init.method !== "GET" ? { origin: PUBLIC_ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}),
          ...(init.headers as Record<string, string> ?? {}) },
      }));
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!;
      return res;
    };
    const chat = async (text: string) => {
      const res = await call("/api/chat", { method: "POST", body: JSON.stringify({ text }) });
      const events: { event: string; data: any }[] = [];
      if (res.headers.get("content-type")?.includes("event-stream")) for await (const m of readSse(res.body!)) events.push({ event: m.event, data: JSON.parse(m.data) });
      return { res, events, of: (e: string) => events.filter((x) => x.event === e).map((x) => x.data) };
    };
    return { call, chat, get cookie() { return cookie; }, set cookie(v: string) { cookie = v; } };
  };
  return { app, browser, quotas, goals, provider, pool, ids };
}
