#!/usr/bin/env bun
/**
 * Checks the configured LLM before a live test, without printing secrets.
 *
 *   bun run peyva:llm-check            no tokens: GET /models (key valid? model listed?) + PEYVA's own logged usage (24 h)
 *                                      + an estimate of the daily-token bucket from the provider's last 429 message
 *   bun run peyva:llm-check --probe    + one tiny request (max_tokens 1, ~25 tokens): the provider's x-ratelimit-* headers,
 *                                      or its 429 message (Groq states daily limit and usage there)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { loadLlmConfig, describeLlm } from "../config.ts";

const cfg = loadLlmConfig();
if (!cfg.ok) { console.error(`LLM not configured: ${[...cfg.missing, ...cfg.problems].join(", ")}`); process.exit(2); }
const { baseURL, apiKey, model } = cfg.llm;
console.log(`LLM: ${describeLlm(cfg.llm)}`);

// 1. No tokens: the model list.
try {
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => null) as { data?: { id: string }[] } | null;
  console.log(`GET /models: HTTP ${res.status}${res.ok ? ` · model listed: ${body?.data?.some((m) => m.id === model) ? "yes" : "NO"}` : ""}`);
} catch (e) { console.log(`GET /models failed: ${(e as Error).message.slice(0, 120)}`); }

// 2. PEYVA's own usage and the last daily-limit message, from the session logs.
const dir = join(import.meta.dir, "..", "..", "output", "sessions");
const since = Date.now() - 24 * 3_600_000;
let used = 0, calls = 0;
let last429: { at: number; limit: number; usedAt: number } | null = null;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
  for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line) continue;
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "turn") continue;
    const at = Date.parse(d.at);
    for (const c of d.llmCalls ?? []) if (at >= since && c.usage) { used += (c.usage.prompt ?? 0) + (c.usage.completion ?? 0); calls++; }
    const m = /tokens per day \(TPD\): Limit (\d+), Used (\d+)/.exec(String(d.llmError ?? ""));
    if (m && (!last429 || at > last429.at)) last429 = { at, limit: Number(m[1]), usedAt: Number(m[2]) };
  }
}
console.log(`PEYVA logged usage, last 24 h: ${calls} LLM calls, ${used} tokens (calls before usage logging existed are not counted)`);
if (last429) {
  // Groq refills the daily budget continuously (its "try again in" times match limit/24h per minute).
  const perMin = last429.limit / 1440;
  const est = Math.min(last429.limit, last429.limit - last429.usedAt + perMin * ((Date.now() - last429.at) / 60_000));
  console.log(`Last daily-limit (429) message: ${new Date(last429.at).toISOString()} · used ${last429.usedAt}/${last429.limit}`);
  console.log(`Estimated available now (refill ${Math.round(perMin)} tokens/min, minus nothing logged since): ~${Math.round(est)} tokens`);
}

// 3. Optional probe (~25 tokens).
if (process.argv.includes("--probe")) {
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 20_000 });
  try {
    const { data, response } = await client.chat.completions.create({ model, max_tokens: 1, temperature: 0, messages: [{ role: "user", content: "ok" }] }).withResponse();
    const h = [...response.headers.entries()].filter(([k]) => k.startsWith("x-ratelimit")).map(([k, v]) => `${k}=${v}`);
    console.log(`probe: ok · usage ${data.usage?.prompt_tokens ?? "?"}+${data.usage?.completion_tokens ?? "?"} tokens`);
    console.log(h.length ? h.join("\n") : "(no x-ratelimit headers)");
  } catch (e) {
    console.log(`probe: ${(e as Error).message.slice(0, 400)}`); // the provider's message (no key in it)
  }
}
