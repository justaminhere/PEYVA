/**
 * PEYVA local web API (Hono). Loopback only, single user, no CORS. Everything the UI shows comes from the agent core,
 * the deterministic comparison engine or PostgreSQL; this file only adapts them to HTTP and Server-Sent Events.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { LlmClient } from "../llm/types.ts";
import type { CommandContext } from "../cli/commands.ts";
import type { ConversationStore } from "../memory/conversations.ts";
import { handleMessage } from "../agent/handle.ts";
import { decidePending } from "../agent/confirm.ts";
import { renderEvent } from "../render/fa.ts";
import { comparisonCards } from "../render/cards.ts";
import type { ToolEvent } from "../agent/tools.ts";
import { AgentHost } from "./host.ts";
import { goalView, goalViews, pendingView } from "./views.ts";
import { saveSession } from "../memory/session-state.ts";
import { tehranDateTime } from "../agent/confirm.ts";

export interface WebDeps {
  host: AgentHost;
  llm: LlmClient;
  ctx: CommandContext;
  store: ConversationStore;
  /** Exact Host header values accepted, e.g. ["127.0.0.1:4317", "localhost:4317"]. Blocks DNS-rebinding. */
  allowedHosts: string[];
  /** Exact Origin values accepted on state-changing requests. */
  allowedOrigins: string[];
  info?: { llm: string; telegram: boolean; db: string };
  /** Session log (output/sessions), same fields as the terminal chat. */
  log?: (e: Record<string, unknown>) => void;
  now?: () => Date;
}

const ChatBody = z.object({ text: z.string().trim().min(1).max(2_000) }).strict();
const ApprovalBody = z.object({ decision: z.enum(["approve", "reject"]), goalId: z.number().int().positive().optional(), key: z.string().max(40).optional() }).strict();

/** Loopback-only guard: exact Host match; for writes also JSON content type, same-origin Origin and no cross-site fetch. */
export function localOnly(allowedHosts: string[], allowedOrigins: string[]): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!allowedHosts.includes(host)) return c.json({ error: "host not allowed" }, 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin !== undefined && !allowedOrigins.includes(origin)) return c.json({ error: "origin not allowed" }, 403);
      const site = c.req.header("sec-fetch-site");
      if (site && site !== "same-origin" && site !== "none") return c.json({ error: "cross-site request refused" }, 403);
      if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return c.json({ error: "content-type must be application/json" }, 415);
    }
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
  };
}

const eventView = (e: ToolEvent) => ({ ...e, textFa: renderEvent(e).trim() });

export function createApp(d: WebDeps) {
  const now = d.now ?? (() => new Date());
  const app = new Hono();
  app.use("*", localOnly(d.allowedHosts, d.allowedOrigins));

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/state", async (c) => c.json(await d.host.run(async (s) => {
    const conv = s.persistence?.conversationId ?? null;
    const transcript = conv ? (await d.store.recent(s.userId, conv, 50)).map((m) => ({ id: m.id, role: m.role, text: m.content })) : [];
    return {
      userId: s.userId, info: d.info ?? null, goal: s.goalSummary(), pending: pendingView(s), transcript,
      resumed: s.resumedFrom ? { savedAtFa: tehranDateTime(s.resumedFrom.savedAt) } : null,
      cards: s.lastComparison ? comparisonCards(s.lastComparison, now()) : null, goals: await goalViews(d.ctx),
    };
  })));

  app.post("/api/chat", async (c) => {
    const body = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "text (1..2000 characters) is required" }, 400);
    return streamSSE(c, async (sse) => {
      const send = (event: string, data: unknown) => sse.writeSSE({ event, data: JSON.stringify(data) });
      // Comment pings keep proxies and idle timeouts from closing a long turn (searches can take tens of seconds).
      const ping = setInterval(() => { void sse.write(": ping\n\n").catch(() => {}); }, 8_000);
      try {
        await d.host.run(async (s) => {
          await send("accepted", { text: body.data.text });
          const queue: Promise<unknown>[] = [];
          const q = (p: Promise<unknown>) => { queue.push(p); };
          const h = await handleMessage(s, d.llm, body.data.text, { commands: d.ctx, store: d.store, hooks: {
            onLlmCall: (i) => q(send("llm", { iteration: i })),
            onTextDelta: (t, i) => q(send("delta", { iteration: i, text: t })),
            onToolStart: (name) => q(send("tool_start", { name })),
            onToolDone: (name, ok, events) => q(send("tool_done", { name, ok, events: events.map(eventView) })),
          } });
          await Promise.all(queue);
          await saveSession(s, d.store); // structured working state, so a restarted server can continue this conversation
          if (h.turn?.newComparison && s.lastComparison) await send("cards", comparisonCards(s.lastComparison, now()));
          // The approval question is shown by the UI's approval card (from `state.pending`), so it is not repeated here.
          await send("reply", { text: h.text, question: h.question, source: h.source, warnings: h.turn?.warnings ?? [], llmError: h.turn?.llmError ?? null });
          d.log?.({ type: "turn", user: body.data.text, reply: h.reply, source: h.source, toolCalls: h.turn?.toolCalls, llmCalls: h.turn?.llmCalls,
            warnings: h.turn?.warnings, llmError: h.turn?.llmError, durationMs: h.turn?.durationMs, goal: s.goalSummary() });
          await send("state", { pending: pendingView(s), goal: s.goalSummary(), goals: await goalViews(d.ctx) });
        });
      } catch (e) {
        await send("error", { message: `خطای داخلی: ${(e as Error).message.slice(0, 200)}` });
      } finally {
        clearInterval(ping);
        await send("done", {});
      }
    });
  });

  app.post("/api/approval", async (c) => {
    const body = ApprovalBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "decision must be approve or reject" }, 400);
    return d.host.run(async (s) => {
      const p = s.pending;
      if (!p) return c.json({ error: "nothing is waiting for approval" }, 409);
      // The button must refer to what is pending now (a stale screen must not approve something else).
      if (p.kind === "goal" && body.data.goalId !== p.goalId) return c.json({ error: "this approval is no longer current" }, 409);
      if (p.kind === "preference" && body.data.key !== p.key) return c.json({ error: "this approval is no longer current" }, 409);
      const reply = await decidePending(s, body.data.decision === "approve");
      await saveSession(s, d.store);
      const conv = s.persistence?.conversationId;
      if (conv && reply) {
        await d.store.add(s.userId, conv, "user", body.data.decision === "approve" ? "(دکمهٔ تأیید)" : "(دکمهٔ رد)", now());
        await d.store.add(s.userId, conv, "assistant", reply, now());
      }
      return c.json({ reply, pending: pendingView(s), goals: await goalViews(d.ctx) });
    });
  });

  app.get("/api/goals", async (c) => c.json({ goals: await goalViews(d.ctx) }));
  app.get("/api/goals/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const g = Number.isInteger(id) ? await d.ctx.goals.get(d.ctx.userId, id) : null;
    return g ? c.json({ goal: await goalView(d.ctx, g) }) : c.json({ error: "not found" }, 404);
  });
  app.post("/api/goals/:id/:action{pause|resume|cancel}", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
    const a = c.req.param("action");
    const r = a === "pause" ? await d.ctx.goals.pause(d.ctx.userId, id) : a === "resume" ? await d.ctx.goals.resume(d.ctx.userId, id) : await d.ctx.goals.cancel(d.ctx.userId, id);
    if (!r.ok) return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
    return c.json({ goal: await goalView(d.ctx, r.goal), goals: await goalViews(d.ctx) });
  });

  app.post("/api/reset", async (c) => { await d.host.reset(); return c.json({ ok: true }); });
  return app;
}
