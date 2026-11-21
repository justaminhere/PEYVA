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
import { TripEditSchema, applyTripEdit, tripView } from "./trip.ts";
import { ToolRunner } from "../agent/tools.ts";
import { analyze } from "../goal/state.ts";
import { parseAmount, toToman } from "../goal/persian.ts";
import type { Session } from "../agent/session.ts";
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
const ProposeBody = z.object({ budget: z.string().trim().min(1).max(40).optional(), stars: z.number().int().min(0).max(5).optional() }).strict()
  .refine((b) => b.budget !== undefined || b.stars !== undefined, "budget or stars");

export function createApp(d: WebDeps) {
  const now = d.now ?? (() => new Date());
  const app = new Hono();
  app.use("*", localOnly(d.allowedHosts, d.allowedOrigins));

  app.get("/api/health", (c) => c.json({ ok: true }));

  /** Everything that can change after any action, read from the session and PostgreSQL. */
  const snapshot = async (s: Session) => {
    const rows = await d.ctx.goals.list(d.ctx.userId);
    return { pending: await pendingView(s, d.ctx), trip: tripView(s, rows), goals: await Promise.all(rows.map((g) => goalView(d.ctx, g))),
      unreadAlerts: await d.ctx.notifications.unreadCount(d.ctx.userId) };
  };
  /** Records an action done with the app's controls in the transcript (shown on reload) and in the LLM's context. */
  const note = async (s: Session, userText: string) => {
    s.messages.push({ role: "user", content: userText });
    const conv = s.persistence?.conversationId;
    if (conv) await d.store.add(s.userId, conv, "user", userText, now());
  };

  app.get("/api/state", async (c) => c.json(await d.host.run(async (s) => {
    const conv = s.persistence?.conversationId ?? null;
    const transcript = conv ? (await d.store.recent(s.userId, conv, 50)).map((m) => ({ id: m.id, role: m.role, text: m.content })) : [];
    return {
      userId: s.userId, info: d.info ?? null, goal: s.goalSummary(), transcript,
      resumed: s.resumedFrom ? { savedAtFa: tehranDateTime(s.resumedFrom.savedAt) } : null,
      cards: s.lastComparison ? comparisonCards(s.lastComparison, now()) : null, ...(await snapshot(s)),
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
          const pendingGoal = s.pending?.kind === "goal" ? s.pending.goalId : null;
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
          await send("reply", { text: h.text, question: h.question, source: h.source, warnings: h.turn?.warnings ?? [], llmError: h.turn?.llmError ?? null,
            activityGoalId: h.source === "approval" && pendingGoal && !s.pending ? pendingGoal : null });
          d.log?.({ type: "turn", user: body.data.text, reply: h.reply, source: h.source, toolCalls: h.turn?.toolCalls, llmCalls: h.turn?.llmCalls,
            warnings: h.turn?.warnings, llmError: h.turn?.llmError, durationMs: h.turn?.durationMs, goal: s.goalSummary() });
          await send("state", { goal: s.goalSummary(), ...(await snapshot(s)) });
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
      const goalId = p.kind === "goal" ? p.goalId : null;
      const reply = await decidePending(s, body.data.decision === "approve");
      await saveSession(s, d.store);
      const conv = s.persistence?.conversationId;
      if (conv && reply) {
        await d.store.add(s.userId, conv, "user", body.data.decision === "approve" ? "(دکمهٔ تأیید)" : "(دکمهٔ رد)", now());
        await d.store.add(s.userId, conv, "assistant", reply, now());
      }
      return c.json({ reply, activityGoalId: goalId, ...(await snapshot(s)) });
    });
  });

  /** One validated edit of the session's trip goal from the brief (no LLM call). */
  app.post("/api/trip", async (c) => {
    const body = TripEditSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ errorFa: "این مقدار معتبر نیست." }, 400);
    return d.host.run(async (s) => {
      const r = applyTripEdit(s, body.data);
      if (!r.ok) return c.json({ errorFa: r.errorFa }, 400);
      await note(s, `✎ ${r.changeFa}`);
      await saveSession(s, d.store);
      return c.json({ changeFa: r.changeFa, ...(await snapshot(s)) });
    });
  });

  /** Re-runs the deterministic comparison for the current goal (real, read-only searches; no LLM call). */
  app.post("/api/compare", async (c) => d.host.run(async (s) => {
    const a = analyze(s.goal, s.now());
    if (!a.ready) return c.json({ errorFa: "هدف هنوز کامل نیست.", ...(await snapshot(s)) }, 409);
    s.turnSearches = 0;
    const out = await new ToolRunner(s, { autoCompare: false }).run("compare_trip_options", "{}");
    if (!out.ok || !s.lastComparison) return c.json({ errorFa: "جست‌وجو انجام نشد.", events: out.events.map(eventView), ...(await snapshot(s)) }, 502);
    s.messages.push({ role: "assistant", content: "(برنامه با شرایط فعلی جست‌وجو کرد و جدول تازه را نشان داد.)" });
    const conv = s.persistence?.conversationId;
    if (conv) await d.store.add(s.userId, conv, "assistant", "نتایج با شرایط فعلی بررسی شد.", now());
    await saveSession(s, d.store);
    return c.json({ cards: comparisonCards(s.lastComparison, now()), events: out.events.map(eventView), ...(await snapshot(s)) });
  }));

  /** Proposes new conditions for a monitored goal. Nothing changes until the user approves in the approval panel. */
  app.post("/api/goals/:id/propose", async (c) => {
    const id = Number(c.req.param("id"));
    const body = ProposeBody.safeParse(await c.req.json().catch(() => null));
    if (!Number.isInteger(id) || !body.success) return c.json({ errorFa: "تغییر معتبر نیست." }, 400);
    return d.host.run(async (s) => {
      if (s.pending && !(s.pending.kind === "goal" && s.pending.goalId === id)) return c.json({ errorFa: "اول به تأییدی که منتظر است جواب بده." }, 409);
      const g = await d.ctx.goals.get(d.ctx.userId, id);
      const ex = g && d.ctx.registry.get(g.type);
      const cur = g && ex?.schema.safeParse(g.structuredConstraints);
      if (!g || !ex || !cur?.success) return c.json({ errorFa: "هدفی با این شماره نیست." }, 404);
      const next: Record<string, unknown> = { ...(cur.data as object) };
      if (body.data.budget !== undefined) {
        const p = parseAmount(body.data.budget);
        if (!p || toToman(p).toman < 100_000) return c.json({ errorFa: `مبلغ «${body.data.budget}» را نتوانستم بخوانم.` }, 400);
        next.budgetToman = toToman(p).toman;
      }
      if (body.data.stars !== undefined) next.minimumHotelStars = body.data.stars || null;
      const r = await d.ctx.goals.updateConstraints(d.ctx.userId, id, next, now());
      if (!r.ok) return c.json({ errorFa: r.reason === "wrong_state" ? "این هدف دیگر قابل تغییر نیست." : `تغییر ثبت نشد (${r.reason}).` }, 409);
      if (!r.changed) return c.json({ unchanged: true, ...(await snapshot(s)) });
      s.pending = { kind: "goal", goalId: id, hash: r.hash, summaryFa: r.summaryFa, change: r.proposal };
      await saveSession(s, d.store);
      return c.json({ ...(await snapshot(s)) });
    });
  });

  app.post("/api/notifications/read", async (c) => d.host.run(async (s) => {
    await d.ctx.notifications.markRead(d.ctx.userId);
    return c.json(await snapshot(s));
  }));

  app.get("/api/goals", async (c) => c.json({ goals: await goalViews(d.ctx) }));
  /** Light refresh of the agent's persistent activities (polled by the UI while visible). Reads PostgreSQL only. */
  app.get("/api/activity", async (c) => c.json({ goals: await goalViews(d.ctx), unreadAlerts: await d.ctx.notifications.unreadCount(d.ctx.userId) }));
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
