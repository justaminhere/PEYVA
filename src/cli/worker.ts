#!/usr/bin/env bun
/**
 * PEYVA background monitoring worker. Runs separately from the chat and keeps going after the chat closes.
 *
 *   bun run peyva:worker            loop (checks due goals, then sleeps PEYVA_WORKER_POLL_SECONDS, default 60)
 *   bun run peyva:worker --once     one pass, then exit (for cron/systemd timers and live tests)
 * Interval between checks of one goal: PEYVA_MONITOR_INTERVAL_HOURS (default 6, minimum 6).
 * Development simulation only: PEYVA_DEV_ALLOW_SHORT_INTERVAL=1 with PEYVA_DEV_INTERVAL_MINUTES.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { openRuntime } from "./runtime.ts";
import { Worker } from "../worker/worker.ts";

const dir = join(import.meta.dir, "..", "..", "output", "worker");
await mkdir(dir, { recursive: true });
const logFile = join(dir, `worker-${new Date().toISOString().slice(0, 10)}.jsonl`);
const log = (e: Record<string, unknown>) => { void appendFile(logFile, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n"); };

const rt = await openRuntime({ onProviderCall: (t) => log({ type: "provider_call", tool: t.tool, args: t.args, outcome: t.outcome.kind, latencyMs: t.outcome.latencyMs }) });
if (!rt) { console.error("PEYVA_DATABASE_URL is not set. Run `bun run db:start` and put the printed URL in .env."); process.exit(2); }

const short = process.env.PEYVA_DEV_ALLOW_SHORT_INTERVAL === "1";
const intervalMs = short && process.env.PEYVA_DEV_INTERVAL_MINUTES ? Number(process.env.PEYVA_DEV_INTERVAL_MINUTES) * 60_000
  : Number(process.env.PEYVA_MONITOR_INTERVAL_HOURS ?? 6) * 3_600_000;
const worker = new Worker(rt.db.db, rt.registry, rt.notifications, {
  id: `${hostname()}:${process.pid}`, intervalMs, allowShortInterval: short,
  log: (e) => { log(e); if (e.type === "check") console.log(`goal #${e.goalId}: ${e.status}${e.errorReason ? ` (${e.errorReason})` : ""} · next ${e.nextCheckAt instanceof Date ? e.nextCheckAt.toISOString() : e.nextCheckAt ?? "-"} · notified ${JSON.stringify(e.notified)}`); },
});
console.log(`PEYVA worker ${worker.o.id} · db ${rt.dbLabel} · interval ${Math.round(intervalMs / 60_000)} min · telegram ${rt.telegramEnabled ? "on" : "off"} · log ${logFile}`);

if (process.argv.includes("--once")) {
  const r = await worker.runOnce();
  log({ type: "pass", checked: r.outcomes.length, expired: r.expired, deliveries: r.delivered });
  console.log(`pass done: ${r.outcomes.length} goal(s) checked, ${r.expired} expired, deliveries ${JSON.stringify(r.delivered)}`);
  await rt.close();
} else {
  const ctrl = new AbortController();
  const stop = () => { console.log("stopping after the current pass…"); ctrl.abort(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  await worker.loop(ctrl.signal, Number(process.env.PEYVA_WORKER_POLL_SECONDS ?? 60) * 1000);
  await rt.close();
}
