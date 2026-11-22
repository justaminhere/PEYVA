#!/usr/bin/env bun
/**
 * PEYVA web app: `bun run peyva:web` (after `bun run web:build`). Serves the API and the built UI. There is no
 * simulated mode: it needs the LLM settings and PEYVA_DATABASE_URL.
 *
 * Local (default): single user, 127.0.0.1 only, no login.
 * Public MVP (PEYVA_PUBLIC=1, for a hosting platform): listens on 0.0.0.0:$PORT behind the platform's HTTPS proxy;
 *   every visitor gets an anonymous signed cookie and their own goals and memory; daily quotas protect the shared
 *   LLM key and the travel provider; the monitoring worker runs inside this process. See docs/DEPLOY_MVP.md.
 */
import { existsSync } from "node:fs";
import { hostname as machineName } from "node:os";
import { join } from "node:path";
import { loadLlmConfig, describeLlm } from "../config.ts";
import { OpenAICompatibleClient } from "../llm/openai-compatible.ts";
import { ConversationStore } from "../memory/conversations.ts";
import { openRuntime } from "../cli/runtime.ts";
import { sessionLogger } from "../cli/log.ts";
import { ensureUser } from "../db/client.ts";
import { Worker } from "../worker/worker.ts";
import { AgentHost } from "./host.ts";
import { webSessionFactory } from "./session.ts";
import { createApp, type WebDeps } from "./app.ts";
import { PgUsageStore } from "./usage-store.ts";
import { Quotas, VisitorIds, VisitorPool, publicVisitor, quotasFromEnv } from "./public.ts";

const env = process.env;
const PUBLIC = env.PEYVA_PUBLIC === "1";
const fail = (msg: string): never => { console.error(msg); process.exit(2); };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const hostname = env.PEYVA_WEB_HOST?.trim() || (PUBLIC ? "0.0.0.0" : "127.0.0.1");
if (!PUBLIC && !LOOPBACK.has(hostname))
  fail(`PEYVA_WEB_HOST=${hostname} refused: the single-user API may only listen on 127.0.0.1, ::1 or localhost (public use: PEYVA_PUBLIC=1).`);
// Public: the platform's PORT if it sets one (Render), else 10000 (Liara asks for the port at deploy time: give 10000).
const port = Number(env.PEYVA_WEB_PORT ?? (PUBLIC ? env.PORT ?? 10000 : 4317));
const devPort = Number(env.PEYVA_WEB_DEV_PORT ?? 5173);

// Public mode: the exact public host name(s) (Render sets RENDER_EXTERNAL_HOSTNAME) and the cookie signing key.
const publicHosts = (env.PEYVA_PUBLIC_HOST?.trim() || env.RENDER_EXTERNAL_HOSTNAME?.trim() || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const secret = env.PEYVA_SESSION_SECRET?.trim() ?? "";
if (PUBLIC) {
  if (!publicHosts.length) fail("PEYVA_PUBLIC=1 needs PEYVA_PUBLIC_HOST (e.g. peyva.onrender.com): requests for any other host are refused.");
  if (secret.length < 32) fail("PEYVA_PUBLIC=1 needs PEYVA_SESSION_SECRET with at least 32 random characters (e.g. `openssl rand -base64 48`).");
}

const cfg = loadLlmConfig();
if (!cfg.ok) {
  console.error("پیوا وب بدون مدل زبانی اجرا نمی‌شود (حالت ساختگی وجود ندارد).");
  if (cfg.missing.length) console.error(`متغیرهای لازم: ${cfg.missing.join(", ")}`);
  for (const p of cfg.problems) console.error(`مشکل: ${p}`);
  process.exit(2);
}
const quotaOptions = PUBLIC ? quotasFromEnv() : null;
const log = await sessionLogger("web");
const rt = await openRuntime({
  goalLimits: quotaOptions ? { maxActivePerUser: quotaOptions.maxActiveGoalsPerVisitor, maxActiveTotal: quotaOptions.maxActiveGoalsTotal } : undefined,
  onProviderCall: ((t: { provider: string; tool: string; args: unknown; outcome: { kind: string; latencyMs: number } }) =>
    log.write({ type: "provider_call", provider: t.provider, tool: t.tool, args: t.args, outcome: t.outcome.kind, latencyMs: t.outcome.latencyMs })) as never,
});
if (!rt) fail("PEYVA_DATABASE_URL تنظیم نشده. اول `bun run db:start` و آدرس را در .env بگذار.");
const runtime = rt!;
// Spend counters live in PostgreSQL so a restart or redeploy does not reset them. No usage, no start (fail closed).
const quotas = quotaOptions ? await Quotas.create(quotaOptions, new PgUsageStore(runtime.db.db)).catch((e) => fail(`usage counters could not be loaded: ${(e as Error).message}`)) : null;

const llm = new OpenAICompatibleClient(cfg.llm);
const store = new ConversationStore(runtime.db.db);
const resumeHours = Number(env.PEYVA_RESUME_HOURS ?? 24);
const resumeMaxAgeMs = Number.isFinite(resumeHours) && resumeHours >= 0 ? resumeHours * 3_600_000 : 24 * 3_600_000;
const persistence = { db: runtime.db.db, goals: runtime.goals, prefs: runtime.prefs };
const sessionsFor = (userId: string) => webSessionFactory({
  provider: runtime.provider, userId, store, persistence, resumeMaxAgeMs,
  onResume: (o) => { void log.write({ type: "resume", userId, ...o }); if (!PUBLIC) console.log(o.resumed ? `گفتگوی #${o.conversationId} از پایگاه داده ادامه یافت (${o.messages} پیام)${o.droppedPending ? `؛ تأیید معلق کنار گذاشته شد: ${o.droppedPending}` : ""}` : `گفتگوی تازه (بازیابی نشد: ${o.reason})`); },
});

let mode: Pick<WebDeps, "host" | "visitor" | "limits" | "allowedHosts" | "allowedOrigins">;
if (PUBLIC) {
  const known = new Set<string>();
  const pool = new VisitorPool((id) => new AgentHost(sessionsFor(id)), Number(env.PEYVA_PUBLIC_MAX_SESSIONS ?? 200));
  mode = {
    visitor: publicVisitor({
      ids: new VisitorIds(secret), pool, quotas: quotas!, secureCookie: env.PEYVA_INSECURE_COOKIE !== "1",
      ipHeader: env.PEYVA_CLIENT_IP_HEADER?.trim().toLowerCase() || undefined,
      // Same services, scoped to the visitor. No Telegram linking in public mode: alerts appear in the web app.
      ctxFor: async (id) => {
        if (!known.has(id)) { await ensureUser(runtime.db.db, id); known.add(id); }
        return { userId: id, goals: runtime.goals, registry: runtime.registry, prefs: runtime.prefs, notifications: runtime.notifications, linker: null };
      },
    }),
    limits: quotas!,
    allowedHosts: publicHosts,
    allowedOrigins: publicHosts.map((h) => `https://${h}`),
  };
} else {
  const names = hostname === "::1" ? ["[::1]"] : ["127.0.0.1", "localhost"];
  const allowedHosts = [...names.map((n) => `${n}:${port}`), ...names.map((n) => `${n}:${devPort}`)];
  mode = { host: new AgentHost(sessionsFor(runtime.userId)), allowedHosts, allowedOrigins: allowedHosts.map((h) => `http://${h}`) };
}

const app = createApp({
  ...mode, llm, ctx: runtime, store,
  info: { llm: describeLlm(cfg.llm), telegram: !PUBLIC && runtime.telegramEnabled, db: PUBLIC ? "PostgreSQL" : runtime.dbLabel, mode: PUBLIC ? "public" : "local" },
  log: (e) => {
    void log.write(e);
    // On a platform the session file is inside the container; failures also go to stdout (no key, no user text).
    const err = (e as { llmError?: string | null }).llmError;
    // Long token-like runs are hidden in case a provider echoes part of a key in its error text.
    if (PUBLIC && e.type === "turn" && err) console.error(`llm error · ${describeLlm(cfg.llm)} · ${err.slice(0, 240).replace(/[A-Za-z0-9_\-]{24,}/g, "***")}`);
  },
});

const dist = join(import.meta.dir, "..", "..", "web", "dist");
if (existsSync(join(dist, "index.html"))) {
  // Built UI: hashed files under /assets (strict file-name check, no path traversal) and index.html for everything else.
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  const hsts: Record<string, string> = PUBLIC ? { "strict-transport-security": "max-age=31536000" } : {};
  app.get("/assets/:file{[A-Za-z0-9._-]+}", async (c) => {
    const f = Bun.file(join(dist, "assets", c.req.param("file")));
    if (!(await f.exists())) return c.notFound();
    return new Response(f, { headers: { "content-type": f.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", ...hsts } });
  });
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound()
    : new Response(Bun.file(join(dist, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-cache", "x-frame-options": "DENY", "referrer-policy": "no-referrer", ...hsts } })));
} else {
  app.get("/", (c) => c.text("UI is not built yet: run `bun run web:build` (or `bun run web:dev` for development).", 503));
}

// Monitoring: a separate `bun run peyva:worker` locally; inside this process on a platform (one service, one bill).
const workerStop = new AbortController();
let workerDone: Promise<void> | null = null;
if (env.PEYVA_EMBEDDED_WORKER === "1" || (PUBLIC && env.PEYVA_EMBEDDED_WORKER !== "0")) {
  const intervalMs = Number(env.PEYVA_MONITOR_INTERVAL_HOURS ?? 6) * 3_600_000;
  const worker = new Worker(runtime.db.db, runtime.registry, runtime.notifications, {
    id: `${machineName()}:${process.pid}:web`, intervalMs,
    log: (e) => { void log.write({ ...e, type: `worker_${String(e.type)}` }); if (e.type === "check") console.log(`worker: goal #${e.goalId} ${e.status}${e.errorReason ? ` (${e.errorReason})` : ""}`); },
  });
  workerDone = worker.loop(workerStop.signal, Number(env.PEYVA_WORKER_POLL_SECONDS ?? 60) * 1000);
  console.log(`worker داخل همین پروسه روشن است (فاصلهٔ بررسی ${Math.round(intervalMs / 3_600_000)} ساعت).`);
}

const server = Bun.serve({ hostname, port, fetch: app.fetch, idleTimeout: 255 });
if (PUBLIC) {
  console.log(`PEYVA public MVP listening on ${hostname}:${server.port} for ${publicHosts.join(", ")} · model ${describeLlm(cfg.llm)} · quotas ${JSON.stringify(quotas!.o)}`);
} else {
  console.log(`پیوا وب: http://${hostname === "::1" ? "[::1]" : "127.0.0.1"}:${server.port} · مدل ${describeLlm(cfg.llm)} · کاربر «${runtime.userId}» (تک‌کاربرهٔ آموزشی، فقط روی همین رایانه)`);
}
console.log(`گزارش: ${log.file}`);
const stop = async () => {
  server.stop();
  workerStop.abort();
  await workerDone?.catch(() => {});
  await runtime.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
