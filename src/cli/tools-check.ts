#!/usr/bin/env bun
/**
 * Live check of PEYVA's tool layer WITHOUT an LLM: the goal is given as structured input, then the same
 * validated tools (update_trip_goal, compare_trip_options) run against the real provider.
 * Proves search + deterministic comparison + Persian rendering live; says nothing about LLM understanding.
 *
 *   bun run peyva:tools-check [--date 1405-09-19] [--nights 3] [--adults 1] [--rooms 1] [--stars 4] [--budget "۳۰ میلیون"]
 */
import { McpTravelProvider } from "../travel/index.ts";
import { Session } from "../agent/session.ts";
import { ToolRunner } from "../agent/tools.ts";
import { renderComparison, renderEvent } from "../render/fa.ts";
import { sessionLogger } from "./log.ts";
import { toLatinDigits } from "../goal/persian.ts";

const arg = (f: string) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : undefined; };
const [jy, jm, jd] = toLatinDigits(arg("--date") ?? "1405-09-19").split("-").map(Number);
const patch: Record<string, unknown> = {
  intent: "trip", origin: "تهران", destination: "کیش",
  departureDate: { text: `${jy}/${jm}/${jd}` },
  nights: Number(arg("--nights") ?? 3), adults: Number(arg("--adults") ?? 1),
};
if (arg("--rooms")) patch.rooms = Number(arg("--rooms"));
if (arg("--stars")) patch.minimumHotelStars = Number(arg("--stars"));
if (arg("--budget")) patch.budgetText = arg("--budget");

const log = await sessionLogger("tools-check");
const provider = McpTravelProvider.create("mrbilit", {
  onCall: (t) => log.write({ type: "provider_call", tool: t.tool, args: t.args, outcome: t.outcome.kind, latencyMs: t.outcome.latencyMs }),
});
const s = new Session(provider);
const runner = new ToolRunner(s);
console.log("آزمون زندهٔ ابزارها — بدون مدل زبانی (ورودی ساخت‌یافته)\n");
try {
  const h = await provider.healthCheck();
  console.log(`سلامت ارائه‌دهنده: ${h.ok ? "سالم" : "ناسالم"}${h.ok ? "" : " :: " + h.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ")}`);
  const g = await runner.run("update_trip_goal", JSON.stringify(patch));
  g.events.forEach((e) => console.log(renderEvent(e)));
  const r = await runner.run("compare_trip_options", "{}");
  r.events.forEach((e) => console.log(renderEvent(e)));
  if (!r.ok) console.log(`نتیجه: ${JSON.parse(r.content).error}`);
  if (s.lastComparison) console.log("\n" + renderComparison(s.lastComparison, new Date()));
  const totals = s.lastComparison?.results.map((c) => c.options[0]?.totalToman ?? null) ?? [];
  await log.write({ type: "tools_check", patch, ok: r.ok, blocked: s.blocked, totals, reasons: s.lastComparison?.results.map((c) => c.reasons) });
  console.log(`\nگزارش: ${log.file}`);
  process.exitCode = totals.some((t) => t !== null) ? 0 : 2;
} finally {
  await provider.close();
}
