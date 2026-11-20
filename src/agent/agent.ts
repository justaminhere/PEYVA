/**
 * One user turn: bounded LLM <-> tool loop. The LLM decides when to call tools; every call is validated by
 * ToolRunner. Final text passes deterministic guards. Nothing here fabricates a reply when the LLM fails.
 */
import type { LlmClient } from "../llm/types.ts";
import { TOOL_SPECS, ToolRunner, type ToolEvent } from "./tools.ts";
import { systemPrompt } from "./prompt.ts";
import type { Session } from "./session.ts";
import { allowedPrices } from "../compare/engine.ts";
import { ACTION_WARNING, MONITORING_NOTICE, PRICE_WARNING, claimsUnauthorizedAction, unverifiedPrices } from "./guards.ts";

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

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const res = await llm.complete([{ role: "system", content: systemPrompt(s) }, ...s.messages], TOOL_SPECS);
    if (!res.ok) {
      return { reply: `${LLM_ERROR_FA[res.cause] ?? "خطای مدل زبانی."} (${res.cause})`, events, newComparison: s.lastComparison?.at !== compareBefore,
        warnings, llmError: `${res.cause}: ${res.message}`, iterations: i };
    }
    if (res.toolCalls.length) {
      s.messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        if (++toolCalls > MAX_TOOL_CALLS_PER_TURN) {
          s.messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ ok: false, error: "tool call limit for this message reached; answer the user now" }) });
          continue;
        }
        const out = await runner.run(call.name, call.arguments);
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
    if (s.goal.monitoringRequested && !s.monitoringNoticeShown) { warnings.push(MONITORING_NOTICE); s.monitoringNoticeShown = true; }
    return { reply, events, newComparison: s.lastComparison?.at !== compareBefore, warnings, llmError: null, iterations: i };
  }
  const reply = "نتوانستم در محدودهٔ مجاز مراحل به نتیجه برسم. لطفاً درخواستت را ساده‌تر یا دقیق‌تر بگو.";
  s.messages.push({ role: "assistant", content: reply });
  return { reply, events, newComparison: s.lastComparison?.at !== compareBefore, warnings, llmError: "iteration limit", iterations: MAX_ITERATIONS };
}
