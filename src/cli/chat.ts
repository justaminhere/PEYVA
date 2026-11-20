#!/usr/bin/env bun
/**
 * PEYVA interactive chat (Phase 3; Phase 2A behaviour without a database). Live mode only: a real configured LLM and the real travel provider.
 * There is no mock fallback: without LLM configuration the CLI explains what is missing and exits.
 *
 *   bun run peyva:chat            commands: /trip  /reset  /help  خروج | exit
 */
import { createInterface } from "node:readline";
import { loadLlmConfig, describeLlm } from "../config.ts";
import { OpenAICompatibleClient } from "../llm/openai-compatible.ts";
import { Session } from "../agent/session.ts";
import { handleMessage } from "../agent/handle.ts";
import { openRuntime } from "./runtime.ts";
import { ConversationStore } from "../memory/conversations.ts";
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
const onCall = (t: { provider: string; tool: string; args: unknown; outcome: { kind: string; latencyMs: number } }) =>
  log.write({ type: "provider_call", provider: t.provider, tool: t.tool, args: t.args, outcome: t.outcome.kind, latencyMs: t.outcome.latencyMs });
// Phase 3: with PEYVA_DATABASE_URL the chat gets memory, monitoring goals and notifications; without it, Phase 2 behaviour.
const rt = await openRuntime({ onProviderCall: onCall as never });
const provider = rt?.provider ?? (await import("../travel/index.ts")).McpTravelProvider.create("mrbilit", { onCall: onCall as never });
const store = rt ? new ConversationStore(rt.db.db) : null;
const session = rt
  ? new Session(provider, () => new Date(), rt.userId, { db: rt.db.db, goals: rt.goals, prefs: rt.prefs, conversationId: await store!.start(rt.userId) })
  : new Session(provider);
if (rt) session.preferences = await rt.prefs.list(rt.userId);

console.log("پیوا · عامل شخصی برای خدمات آنلاین ایرانی (فاز ۳)");
console.log(`حالت زنده · مدل: ${describeLlm(cfg.llm)} · ارائه‌دهنده: MrBilit (غیررسمی، فقط جست‌وجو)`);
console.log(rt ? `حافظه: PostgreSQL ${rt.dbLabel} · کاربر «${rt.userId}» (حالت آموزشی تک‌کاربره) · تلگرام ${rt.telegramEnabled ? "پیکربندی شده" : "خاموش"}`
  : "حافظه: خاموش (PEYVA_DATABASE_URL تنظیم نشده؛ پیگیری و ترجیحات در دسترس نیست)");
console.log(`دستورها: /trip (هدف فعلی) · /reset · خروج${rt ? " · /help (هدف‌ها، اعلان‌ها، ترجیحات)" : ""}`);
console.log(`گزارش جلسه: ${log.file}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY ?? false });
const prompt = () => process.stdout.write("شما › ");
prompt();
let busy: Promise<unknown> = Promise.resolve();
const shutdown = async () => { await busy.catch(() => {}); if (rt) await rt.close(); else await provider.close(); process.exit(0); };

rl.on("line", (line) => {
  busy = busy.then(async () => {
    const text = line.trim();
    if (!text) return prompt();
    if (["خروج", "exit", "/exit", "quit", "/q"].includes(text)) { rl.close(); return; }
    if (text === "/trip") { console.log(JSON.stringify(session.goalSummary(), null, 2)); return prompt(); }
    if (text === "/reset") { session.reset(); console.log("گفتگو از نو شروع شد."); return prompt(); }
    if (text === "/help" && !rt) { console.log("بدون پایگاه داده فقط /trip و /reset هست."); return prompt(); }
    if (!text.startsWith("/") && !session.pending) console.log("  … پیوا در حال کار است");
    try {
      const h = await handleMessage(session, llm, text, { commands: rt, store });
      if (!h.turn) {
        console.log(`\nپیوا › ${h.reply}\n`);
        await log.write({ type: h.source, user: text, reply: h.reply });
        return prompt();
      }
      const t = { ...h.turn, reply: h.reply };
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
