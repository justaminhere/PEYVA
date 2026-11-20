/** TEST-ONLY wiring of the real web app: real PostgreSQL, recorded provider data, scripted (streaming) LLM. */
import { ensureUser, type DbHandle } from "../../src/db/client.ts";
import { GoalService } from "../../src/goals/service.ts";
import { ExecutorRegistry } from "../../src/goals/types.ts";
import { makeTravelPriceExecutor } from "../../src/goals/travel.ts";
import { PreferenceStore } from "../../src/memory/preferences.ts";
import { ConversationStore } from "../../src/memory/conversations.ts";
import { NotificationService } from "../../src/notify/service.ts";
import { Session } from "../../src/agent/session.ts";
import type { CommandContext } from "../../src/cli/commands.ts";
import type { LlmClient } from "../../src/llm/types.ts";
import { AgentHost } from "../../src/web/host.ts";
import { createApp } from "../../src/web/app.ts";
import { readSse } from "../../web/src/sse.ts";
import { RecordedProvider } from "./recorded-provider.ts";

export const HOST = "127.0.0.1:4317";
export const ORIGIN = `http://${HOST}`;

export async function webApp(db: DbHandle, llm: LlmClient, now: () => Date) {
  await ensureUser(db.db, "amin");
  const provider = new RecordedProvider(now);
  const registry = new ExecutorRegistry().register(makeTravelPriceExecutor(provider));
  const ctx: CommandContext = { userId: "amin", registry, goals: new GoalService(db.db, registry), prefs: new PreferenceStore(db.db),
    notifications: new NotificationService(db.db, null, { now }), linker: null };
  const store = new ConversationStore(db.db);
  const host = new AgentHost(async () => new Session(provider, now, "amin", { db: db.db, goals: ctx.goals, prefs: ctx.prefs, conversationId: await store.start("amin", now()) }));
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
