/**
 * One user turn: bounded LLM <-> tool loop. The LLM decides when to call tools; every call is validated by
 * ToolRunner. Final text passes deterministic guards. Nothing here fabricates a reply when the LLM fails.
 */
import type { LlmClient } from "../llm/types.ts";
import { TOOL_SPECS, ToolRunner, type ToolEvent } from "./tools.ts";
import { systemPrompt } from "./prompt.ts";
import type { Session } from "./session.ts";
import { allowedPrices } from "../compare/engine.ts";
import { ACTION_WARNING, DATE_WARNING, MONITORING_NOTICE, PRICE_WARNING, claimsUnauthorizedAction, unverifiedMonths, unverifiedPrices } from "./guards.ts";
import { gregorianToJalali } from "../goal/dates.ts";
import { signalsIn } from "../goal/signals.ts";
import { crossCheckPatch } from "./tools.ts";
import { todayInTehran } from "../travel/index.ts";

export const MAX_ITERATIONS = 6;
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

export async function runTurn(s: Session, llm: LlmClient, userText: string): Promise<TurnResult> {
  s.messages.push({ role: "user", content: userText });
  s.turnSearches = 0;
  const runner = new ToolRunner(s);
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
    const res = await llm.complete([{ role: "system", content: systemPrompt(s) }, ...s.messages, ...(correction ? [{ role: "system" as const, content: correction }] : [])], TOOL_SPECS);
    correction = null;
    llmCalls.push({ ms: Math.round(performance.now() - c0), ok: res.ok, ...(res.ok ? { usage: res.usage } : { cause: res.cause }) });
    // Some providers (e.g. Groq) reject a malformed tool call server-side with HTTP 400. Retry once with a correction.
    if (!res.ok && res.cause === "bad_request" && /tool call validation failed|tool_use_failed|not in request\.tools|failed to call a function/i.test(res.message) && !retriedInvalidCall) {
      retriedInvalidCall = true;
      correction = `Your previous tool call was rejected by the API (${res.message.slice(0, 160)}). Use exactly one of these tool names: ${TOOL_SPECS.map((t) => t.name).join(", ")}, with JSON arguments matching their schema.`;
      continue;
    }
    if (!res.ok) {
      return done({ reply: `${LLM_ERROR_FA[res.cause] ?? "خطای مدل زبانی."} (${res.cause})`, events, newComparison: s.lastComparison?.at !== compareBefore,
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
    // The user's own words, checked by code after the turn: monitoring wish and details that were never recorded.
    const sig = signalsIn(userText);
    if (sig.monitoring && !s.goal.monitoringRequested) { s.goal.monitoringRequested = true; appActions.push("monitoringRequested set from the user's words"); }
    const missed = crossCheckPatch({}, userText, s.goal).unrecorded.filter((u) => !u.startsWith("monitoringRequested"));
    if (missed.length) warnings.push(`⚠ این جزئیات از پیامت در هدف ثبت نشد: ${missed.map((m) => m.split(":")[0]).map((k) => ({ travellers: "تعداد مسافر", budget: "بودجه", minimumHotelStars: "ستارهٔ هتل", nights: "تعداد شب" } as Record<string, string>)[k!] ?? k).join("، ")}. دوباره بگو یا با /goal بررسی کن.`);
    if (s.goal.monitoringRequested && !s.monitoringNoticeShown) { warnings.push(MONITORING_NOTICE); s.monitoringNoticeShown = true; }
    return done({ reply, events, newComparison: s.lastComparison?.at !== compareBefore, warnings, llmError: null, iterations: i });
  }
  const reply = "نتوانستم در محدودهٔ مجاز مراحل به نتیجه برسم. لطفاً درخواستت را ساده‌تر یا دقیق‌تر بگو.";
  s.messages.push({ role: "assistant", content: reply });
  return done({ reply, events, newComparison: s.lastComparison?.at !== compareBefore, warnings, llmError: "iteration limit", iterations: MAX_ITERATIONS });
}
