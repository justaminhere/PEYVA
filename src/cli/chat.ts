#!/usr/bin/env bun
/**
 * PEYVA interactive chat (Phase 2A). Live mode only: a real configured LLM and the real travel provider.
 * There is no mock fallback: without LLM configuration the CLI explains what is missing and exits.
 *
 *   bun run peyva:chat            commands: /goal  /reset  خروج | exit
 */
import { createInterface } from "node:readline";
import { loadLlmConfig, describeLlm } from "../config.ts";
import { OpenAICompatibleClient } from "../llm/openai-compatible.ts";
import { McpTravelProvider } from "../travel/index.ts";
import { Session } from "../agent/session.ts";
import { runTurn } from "../agent/agent.ts";
import { renderComparison, renderEvent } from "../render/fa.ts";
import { sessionLogger } from "./log.ts";

const cfg = loadLlmConfig();
if (!cfg.ok) {
  console.error("پیوا نمی‌تواند در حالت زنده اجرا شود: مدل زبانی پیکربندی نشده است.");
  if (cfg.missing.length) console.error(`متغیرهای لازم: ${cfg.missing.join(", ")}`);
  for (const p of cfg.problems) console.error(`مشکل: ${p}`);
  console.error("راهنما: cp .env.example .env  و مقدارها را پر کن. (حالت آزمایشی/ساختگی در CLI وجود ندارد.)");
  process.exit(2);
}

const llm = new OpenAICompatibleClient(cfg.llm);
const log = await sessionLogger("chat");
const provider = McpTravelProvider.create("mrbilit", {
  onCall: (t) => log.write({ type: "provider_call", provider: t.provider, tool: t.tool, args: t.args, outcome: t.outcome.kind, latencyMs: t.outcome.latencyMs }),
});
const session = new Session(provider);

console.log("پیوا · عامل شخصی برای خدمات آنلاین ایرانی (فاز ۲الف)");
console.log(`حالت زنده · مدل: ${describeLlm(cfg.llm)} · ارائه‌دهنده: MrBilit (غیررسمی، فقط جست‌وجو)`);
console.log("دستورها: /goal (هدف فعلی) · /reset · خروج");
console.log(`گزارش جلسه: ${log.file}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY ?? false });
const prompt = () => process.stdout.write("شما › ");
prompt();
let busy: Promise<unknown> = Promise.resolve();
const shutdown = async () => { await busy.catch(() => {}); await provider.close(); process.exit(0); };

rl.on("line", (line) => {
  busy = busy.then(async () => {
    const text = line.trim();
    if (!text) return prompt();
    if (["خروج", "exit", "/exit", "quit", "/q"].includes(text)) { rl.close(); return; }
    if (text === "/goal") { console.log(JSON.stringify(session.goalSummary(), null, 2)); return prompt(); }
    if (text === "/reset") { session.reset(); console.log("گفتگو از نو شروع شد."); return prompt(); }
    console.log("  … پیوا در حال کار است");
    try {
      const t = await runTurn(session, llm, text);
      for (const e of t.events) console.log(renderEvent(e));
      if (t.newComparison && session.lastComparison) console.log(renderComparison(session.lastComparison, new Date()));
      console.log(`\nپیوا › ${t.reply}`);
      for (const w of t.warnings) console.log(w);
      await log.write({ type: "turn", user: text, reply: t.reply, toolCalls: t.toolCalls, llmCalls: t.llmCalls, appActions: t.appActions, durationMs: t.durationMs, goal: session.goalSummary(),
        events: t.events, warnings: t.warnings, llmError: t.llmError, iterations: t.iterations,
        comparisonTotals: t.newComparison ? session.lastComparison?.results.map((c) => c.options[0]?.totalToman ?? null) : undefined });
    } catch (e) {
      console.log(`پیوا › خطای داخلی: ${(e as Error).message}`);
      await log.write({ type: "internal_error", message: (e as Error).message });
    }
    console.log("");
    prompt();
  });
});
rl.on("close", () => void shutdown());
