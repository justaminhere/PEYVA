#!/usr/bin/env bun
/**
 * PEYVA local web app: `bun run peyva:web` (after `bun run web:build`). Serves the API and the built UI on
 * 127.0.0.1 only. Needs the same .env as the chat (LLM + PEYVA_DATABASE_URL). There is no simulated mode.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadLlmConfig, describeLlm } from "../config.ts";
import { OpenAICompatibleClient } from "../llm/openai-compatible.ts";
import { Session } from "../agent/session.ts";
import { ConversationStore } from "../memory/conversations.ts";
import { openRuntime } from "../cli/runtime.ts";
import { sessionLogger } from "../cli/log.ts";
import { AgentHost } from "./host.ts";
import { createApp } from "./app.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const hostname = process.env.PEYVA_WEB_HOST?.trim() || "127.0.0.1";
if (!LOOPBACK.has(hostname)) {
  console.error(`PEYVA_WEB_HOST=${hostname} refused: the single-user API may only listen on 127.0.0.1, ::1 or localhost.`);
  process.exit(2);
}
const port = Number(process.env.PEYVA_WEB_PORT ?? 4317);
const devPort = Number(process.env.PEYVA_WEB_DEV_PORT ?? 5173);

const cfg = loadLlmConfig();
if (!cfg.ok) {
  console.error("پیوا وب بدون مدل زبانی اجرا نمی‌شود (حالت ساختگی وجود ندارد).");
  if (cfg.missing.length) console.error(`متغیرهای لازم: ${cfg.missing.join(", ")}`);
  for (const p of cfg.problems) console.error(`مشکل: ${p}`);
  process.exit(2);
}
const log = await sessionLogger("web");
const rt = await openRuntime({ onProviderCall: ((t: { provider: string; tool: string; args: unknown; outcome: { kind: string; latencyMs: number } }) =>
  log.write({ type: "provider_call", provider: t.provider, tool: t.tool, args: t.args, outcome: t.outcome.kind, latencyMs: t.outcome.latencyMs })) as never });
if (!rt) { console.error("PEYVA_DATABASE_URL تنظیم نشده. اول `bun run db:start` و آدرس را در .env بگذار."); process.exit(2); }

const llm = new OpenAICompatibleClient(cfg.llm);
const store = new ConversationStore(rt.db.db);
const host = new AgentHost(async () => {
  const s = new Session(rt.provider, () => new Date(), rt.userId, { db: rt.db.db, goals: rt.goals, prefs: rt.prefs, conversationId: await store.start(rt.userId) });
  s.preferences = await rt.prefs.list(rt.userId);
  return s;
});
const names = hostname === "::1" ? ["[::1]"] : ["127.0.0.1", "localhost"];
const allowedHosts = [...names.map((n) => `${n}:${port}`), ...names.map((n) => `${n}:${devPort}`)];
const app = createApp({
  host, llm, ctx: rt, store, allowedHosts, allowedOrigins: allowedHosts.map((h) => `http://${h}`),
  info: { llm: describeLlm(cfg.llm), telegram: rt.telegramEnabled, db: rt.dbLabel },
  log: (e) => void log.write(e),
});

const dist = join(import.meta.dir, "..", "..", "web", "dist");
if (existsSync(join(dist, "index.html"))) {
  // Built UI: hashed files under /assets (strict file-name check, no path traversal) and index.html for everything else.
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  app.get("/assets/:file{[A-Za-z0-9._-]+}", async (c) => {
    const f = Bun.file(join(dist, "assets", c.req.param("file")));
    if (!(await f.exists())) return c.notFound();
    return new Response(f, { headers: { "content-type": f.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
  });
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound()
    : new Response(Bun.file(join(dist, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-cache", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } })));
} else {
  app.get("/", (c) => c.text("UI is not built yet: run `bun run web:build` (or `bun run web:dev` for development).", 503));
}

const server = Bun.serve({ hostname, port, fetch: app.fetch, idleTimeout: 255 });
console.log(`پیوا وب: http://${hostname === "::1" ? "[::1]" : "127.0.0.1"}:${server.port} · مدل ${describeLlm(cfg.llm)} · کاربر «${rt.userId}» (تک‌کاربرهٔ آموزشی، فقط روی همین رایانه)`);
console.log(`گزارش: ${log.file}`);
const stop = async () => { server.stop(); await rt.close(); process.exit(0); };
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
