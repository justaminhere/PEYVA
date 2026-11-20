#!/usr/bin/env bun
/**
 * Estimates the fixed token cost that every LLM request carries before any conversation history:
 * the system prompt (with an empty goal) and the tool definitions. No network, no API key.
 * Estimate = characters / 3.5 (rough; Persian text usually costs more tokens per character).
 * The real numbers per request are in the chat log (`llmCalls[].usage`).
 *
 *   bun run peyva:token-budget
 */
import { TOOL_SPECS } from "../agent/tools.ts";
import { systemPrompt } from "../agent/prompt.ts";
import { Session } from "../agent/session.ts";
import type { TravelSearchProvider } from "../travel/index.ts";

const CHARS_PER_TOKEN = 3.5;
const est = (s: string) => Math.round(s.length / CHARS_PER_TOKEN);
const session = new Session({} as TravelSearchProvider, () => new Date("2026-11-20T14:30:00Z"));
const system = systemPrompt(session);
const toolsJson = JSON.stringify(TOOL_SPECS.map((t) => ({ type: "function", function: t })));
const rows: [string, number, number][] = [
  ["system prompt + goal state", system.length, est(system)],
  ...TOOL_SPECS.map((t) => [`tool ${t.name}`, JSON.stringify(t).length, est(JSON.stringify(t))] as [string, number, number]),
];
const perTool = rows.slice(1).reduce((a, r) => a + r[2], 0);
rows.push(["tool wrapper overhead", toolsJson.length - rows.slice(1).reduce((a, r) => a + r[1], 0), est(toolsJson) - perTool]);
const total = est(system) + est(toolsJson);
console.log("part".padEnd(36), "chars".padStart(7), "≈tokens".padStart(8));
for (const [name, chars, tok] of rows) console.log(name.padEnd(36), String(chars).padStart(7), String(tok).padStart(8));
console.log("TOTAL fixed per request".padEnd(36), String(system.length + toolsJson.length).padStart(7), String(total).padStart(8));
console.log(JSON.stringify({ totalTokensEstimate: total, charsPerToken: CHARS_PER_TOKEN }));
