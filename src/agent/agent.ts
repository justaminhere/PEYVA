/**
 * One user turn: bounded LLM <-> tool loop. The LLM decides when to call tools; every call is validated by
 * ToolRunner. Final text passes deterministic guards. Nothing here fabricates a reply when the LLM fails.
 */
import type { ChatMessage, LlmClient } from "../llm/types.ts";
import { CHAT_TOOL_SPECS, ToolRunner, chatToolSpecs, type ToolEvent } from "./tools.ts";
import { systemPrompt } from "./prompt.ts";
import type { Session } from "./session.ts";
import { allowedPrices } from "../compare/engine.ts";
import { ACTION_WARNING, DATE_WARNING, MONITORING_NOTICE, PRICE_WARNING, claimsUnauthorizedAction, unverifiedMonths, unverifiedPrices } from "./guards.ts";
import { gregorianToJalali } from "../goal/dates.ts";
import { signalsIn } from "../goal/signals.ts";
import { crossCheckPatch } from "./tools.ts";
import { todayInTehran } from "../travel/index.ts";

export const MAX_ITERATIONS = 6;

/**
 * Phase 2B token diet: tool results from earlier turns are replaced by short summaries before each request.
 * The current goal is always in the system prompt, and the comparison table was already shown to the user,
 * so the full JSON of old results only costs tokens. Results of the current turn stay complete.
 */
export function compactHistory(msgs: ChatMessage[]): ChatMessage[] {
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === "user") { lastUser = i; break; }
  return msgs.map((m, i) => (i < lastUser && m.role === "tool" ? { ...m, content: summarizeToolResult(m.content) } : m));
}

export function summarizeToolResult(content: string): string {
  try {
    const j = JSON.parse(content) as Record<string, any>;
    if (j.ok === false) return JSON.stringify({ ok: false, error: String(j.error ?? "").slice(0, 120) });
    if (j.goal && j.analysis) return JSON.stringify({ ok: true, note: "goal updated (the current goal is in the system prompt)",
      ...(j.comparison ? { comparison: JSON.parse(summarizeToolResult(JSON.stringify(j.comparison))) } : {}) });
    if (Array.isArray(j.candidates)) return JSON.stringify({ ok: true, note: "comparison already shown to the user", best: j.best ?? null,
      candidates: j.candidates.map((c: any) => ({ n: c.n, datesFa: c.datesFa, status: c.status })) });
    if (j.results) return JSON.stringify({ ok: j.ok, note: "search already done", status: j.status, count: j.count });
  } catch { /* not JSON: fall through */ }
  return content.slice(0, 200);
}
export const MAX_TOOL_CALLS_PER_TURN = 12;

export interface TurnResult {
  reply: string;
  events: ToolEvent[];
  /** True when the comparison table was (re)computed in this turn and should be shown. */
  newComparison: boolean;
  warnings: string[];
  llmError: string | null;
  iterations: number;
  /** Every tool call the LLM made this turn, with its (truncated) arguments and whether validation/execution succeeded. */
  toolCalls: { name: string; arguments: string; ok: boolean }[];
  /** Each LLM request: latency, outcome and token usage (to diagnose slow turns). */
  llmCalls: { ms: number; ok: boolean; cause?: string; usage?: { prompt: number | null; completion: number | null } }[];
  /** Deterministic state changes the app made itself this turn (not the LLM). */
  appActions: string[];
  durationMs: number;
}

const LLM_ERROR_FA: Record<string, string> = {
  config: "پیکربندی مدل زبانی کامل نیست.",
  auth: "کلید API مدل زبانی پذیرفته نشد.",
  rate_limit: "سرویس مدل زبانی محدودیت نرخ اعمال کرد؛ کمی بعد دوباره امتحان کن.",
  timeout: "مدل زبانی در زمان مجاز پاسخ نداد.",
  network: "اتصال به سرویس مدل زبانی برقرار نشد.",
  bad_request: "سرویس مدل زبانی درخواست را رد کرد (مدل یا تنظیمات را بررسی کن).",
  malformed: "پاسخ مدل زبانی قابل خواندن نبود.",
  provider: "سرویس مدل زبانی خطا داد.",
};

/** "Please try again in 8m9.888s" + "(TPD)" -> a Persian hint with the limit type and wait time. */
export function rateLimitHint(message: string): string {
  const daily = /per day|\bTPD\b|\bRPD\b/i.test(message);
  const m = message.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i);
  const fa = (n: number) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
  let wait = "";
  if (m && (m[1] || m[2] || m[3])) {
    const mins = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) + (Number(m[3] ?? 0) > 0 ? 1 : 0);
    wait = mins >= 1 ? ` حدود ${fa(mins)} دقیقهٔ دیگر دوباره امتحان کن.` : " چند ثانیهٔ دیگر دوباره امتحان کن.";
  }
  return `${daily ? "سهمیهٔ روزانهٔ توکن یا درخواستِ سرویس مدل زبانی تمام شده است." : "سرویس مدل زبانی محدودیت نرخ دقیقه‌ای اعمال کرد."}${wait}`;
}

export async function runTurn(s: Session, llm: LlmClient, userText: string): Promise<TurnResult> {
  s.messages.push({ role: "user", content: userText });
  s.turnSearches = 0;
  const runner = new ToolRunner(s, { tools: "chat", autoCompare: true });
  const events: ToolEvent[] = [];
  const warnings: string[] = [];
  const compareBefore = s.lastComparison?.at ?? null;
  let toolCalls = 0;
  const calls: TurnResult["toolCalls"] = [];
  const llmCalls: TurnResult["llmCalls"] = [];
  const appActions: string[] = [];
  let correction: string | null = null;
  let retriedInvalidCall = false;
  const t0 = performance.now();
  const done = (r: Omit<TurnResult, "toolCalls" | "durationMs" | "llmCalls" | "appActions">): TurnResult =>
    ({ ...r, toolCalls: calls, llmCalls, appActions, durationMs: Math.round(performance.now() - t0) });

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const c0 = performance.now();
    const res = await llm.complete([{ role: "system", content: systemPrompt(s) }, ...compactHistory(s.messages), ...(correction ? [{ role: "system" as const, content: correction }] : [])], chatToolSpecs(s));
    correction = null;
    llmCalls.push({ ms: Math.round(performance.now() - c0), ok: res.ok, ...(res.ok ? { usage: res.usage } : { cause: res.cause }) });
    // Some providers (e.g. Groq) reject a malformed tool call server-side with HTTP 400. Retry once with a correction.
    if (!res.ok && res.cause === "bad_request" && /tool call validation failed|tool_use_failed|not in request\.tools|failed to call a function/i.test(res.message) && !retriedInvalidCall) {
      retriedInvalidCall = true;
      correction = `Your previous tool call was rejected by the API (${res.message.slice(0, 160)}). Use exactly one of these tool names: ${CHAT_TOOL_SPECS.map((t) => t.name).join(", ")}, with JSON arguments matching their schema.`;
      continue;
    }
    if (!res.ok) {
      // The user's own words are still checked by code when the LLM fails (e.g. the monitoring wish).
      afterTurnChecks(s, userText, warnings, appActions, false);
      const msg = res.cause === "rate_limit" ? rateLimitHint(res.message) : LLM_ERROR_FA[res.cause] ?? "خطای مدل زبانی.";
      return done({ reply: `${msg} (${res.cause})`, events, newComparison: s.lastComparison?.at !== compareBefore,
        warnings, llmError: `${res.cause}: ${res.message}`, iterations: i });
    }
    if (res.toolCalls.length) {
      s.messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        if (++toolCalls > MAX_TOOL_CALLS_PER_TURN) {
          s.messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ ok: false, error: "tool call limit for this message reached; answer the user now" }) });
          continue;
        }
        const out = await runner.run(call.name, call.arguments);
        calls.push({ name: call.name, arguments: call.arguments.slice(0, 600), ok: out.ok });
        events.push(...out.events);
        s.messages.push({ role: "tool", toolCallId: call.id, content: out.content });
      }
      continue;
    }
    let reply = (res.text ?? "").trim();
    if (!reply) reply = "(مدل زبانی پاسخ متنی نداد.)";
    s.messages.push({ role: "assistant", content: reply });
    const allowed = allowedPrices(s.lastComparison?.results ?? []);
    if (s.goal.budget) allowed.add(s.goal.budget.toman);
    for (const r of s.searches.values() as Iterable<{ items?: { totalPrice?: number | null }[] }>)
      for (const it of r.items ?? []) if (it.totalPrice) allowed.add(it.totalPrice);
    if (unverifiedPrices(reply, allowed).length) warnings.push(PRICE_WARNING);
    if (claimsUnauthorizedAction(reply)) warnings.push(ACTION_WARNING);
    const d = s.goal.dates;
    const known = [todayInTehran(s.now()), d.departure, d.return, d.window?.from, d.window?.to,
      ...(s.lastComparison?.results.flatMap((c) => [c.candidate.departure, c.candidate.return]) ?? [])].filter((x): x is string => !!x);
    // A window spans months: allow every month between its ends.
    if (d.window) for (let x = d.window.from; x <= d.window.to; x = new Date(Date.parse(x) + 86_400_000 * 10).toISOString().slice(0, 10)) known.push(x);
    if (unverifiedMonths(reply, known, (iso) => gregorianToJalali(iso).jm).length) warnings.push(DATE_WARNING);
    afterTurnChecks(s, userText, warnings, appActions, true);
    return done({ reply, events, newComparison: s.lastComparison?.at !== compareBefore, warnings, llmError: null, iterations: i });
  }
  afterTurnChecks(s, userText, warnings, appActions, true);
  const reply = "نتوانستم در محدودهٔ مجاز مراحل به نتیجه برسم. لطفاً درخواستت را ساده‌تر یا دقیق‌تر بگو.";
  s.messages.push({ role: "assistant", content: reply });
  return done({ reply, events, newComparison: s.lastComparison?.at !== compareBefore, warnings, llmError: "iteration limit", iterations: MAX_ITERATIONS });
}

/**
 * Deterministic checks of the user's own words, run on every exit of a turn: the monitoring wish is recorded and its
 * notice shown; details the user gave that never reached the goal are listed (only when the LLM actually processed the turn).
 */
function afterTurnChecks(s: Session, userText: string, warnings: string[], appActions: string[], llmProcessed: boolean) {
  const sig = signalsIn(userText);
  if (sig.monitoring && !s.goal.monitoringRequested) { s.goal.monitoringRequested = true; appActions.push("monitoringRequested set from the user's words"); }
  if (llmProcessed) {
    const missed = crossCheckPatch({}, userText, s.goal).unrecorded.filter((u) => !u.startsWith("monitoringRequested"));
    if (missed.length) warnings.push(`⚠ این جزئیات از پیامت در هدف ثبت نشد: ${missed.map((m) => m.split(":")[0]).map((k) => ({ travellers: "تعداد مسافر", budget: "بودجه", minimumHotelStars: "ستارهٔ هتل", nights: "تعداد شب" } as Record<string, string>)[k!] ?? k).join("، ")}. دوباره بگو یا با /goal بررسی کن.`);
  }
  if (s.goal.monitoringRequested && !s.monitoringNoticeShown && !s.persistence) { warnings.push(MONITORING_NOTICE); s.monitoringNoticeShown = true; }
}
