#!/usr/bin/env bun
/**
 * PEYVA travel integration CLI (Phase 1 spike + Phase 1.5 readiness).
 *
 *   bun run src/cli.ts tools      [mrbilit|flytoday|all]          MCP discovery (no provider traffic)
 *   bun run src/cli.ts preflight  [mrbilit|flytoday|all]          DNS/TLS to provider backends (no HTTP)
 *   bun run src/cli.ts run        [mrbilit|flytoday|all] [--force] Tehran->Kish scenario via TravelSearchProvider
 *   bun run src/cli.ts live-check [mrbilit|flytoday|all] [--cycles 1..3] [--gap-s 20..600]
 *
 * Read-only. No mock data: a failed call is reported as failed. Evidence is written as it happens.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { McpSession } from "./mcp.ts";
import { PROVIDERS, type ProviderId } from "./providers.ts";
import { SCENARIO } from "./scenario.ts";
import { cheapest } from "./normalize.ts";
import { preflight } from "./preflight.ts";
import { redactText, redactValue } from "./sanitize.ts";
import { McpTravelProvider, type CallTrace } from "./travel/mcp-provider.ts";
import type { SearchResult, TravelSearchProvider } from "./travel/provider.ts";
import { nullCounts, stayRatio } from "./travel/checks.ts";
import type { NormalizedFlight, NormalizedHotel } from "./types.ts";

const OUT_ROOT = join(import.meta.dir, "..", "output");

function numArg(flag: string, fallback: number, min: number, max: number): number {
  const i = process.argv.indexOf(flag);
  const v = i > 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isFinite(v)) throw new Error(`${flag} needs a number`);
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

function selectProviders(arg: string | undefined): ProviderId[] {
  if (!arg || arg === "all" || arg.startsWith("--")) return ["mrbilit", "flytoday"];
  if (arg in PROVIDERS) return [arg as ProviderId];
  throw new Error(`unknown provider '${arg}' (use mrbilit, flytoday or all)`);
}

/** Writes raw calls immediately and rewrites report.json after every step, so an interrupted run keeps its evidence. */
class Recorder {
  private seq = 0;
  readonly report: Record<string, unknown> & { steps: unknown[]; calls: unknown[] };
  constructor(readonly dir: string, meta: Record<string, unknown>) {
    this.report = { ...meta, startedAt: new Date().toISOString(), finished: false, steps: [], calls: [] };
  }
  static async create(prefix: string, meta: Record<string, unknown>) {
    const dir = join(OUT_ROOT, `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    await mkdir(join(dir, "raw"), { recursive: true });
    const r = new Recorder(dir, meta);
    await r.flush();
    return r;
  }
  onCall = async (t: CallTrace) => {
    const file = `raw/${t.provider}-${String(++this.seq).padStart(2, "0")}-${t.tool}.json`;
    const o = t.outcome;
    await Bun.write(join(this.dir, file), JSON.stringify(redactValue({
      provider: t.provider, tool: t.tool, args: t.args, checkedAt: t.checkedAt, outcome: o.kind, latencyMs: o.latencyMs,
      ...(o.kind === "ok" ? { response: o.data } : { error: o.message }),
    }), null, 2));
    this.report.calls.push({ provider: t.provider, tool: t.tool, args: t.args, checkedAt: t.checkedAt, outcome: o.kind, latencyMs: o.latencyMs, rawFile: file });
    await this.flush();
  };
  async step(s: Record<string, unknown>) {
    this.report.steps.push(s);
    await this.flush();
  }
  async flush() {
    await Bun.write(join(this.dir, "report.json"), JSON.stringify(redactValue(this.report), null, 2));
  }
  async finish(extra: Record<string, unknown>) {
    Object.assign(this.report, extra, { finished: true, finishedAt: new Date().toISOString() });
    await this.flush();
  }
}

/** Compact, application-shaped summary of a search (what a future app layer would see). */
function summarize<T>(leg: string, r: SearchResult<T>) {
  return {
    leg, provider: r.provider, status: r.status, checkedAt: r.checkedAt, latencyMs: r.latencyMs,
    count: r.items.length, totalAvailable: r.totalAvailable, truncated: r.truncated, notes: r.notes, error: r.error,
  };
}

function printResult<T>(leg: string, r: SearchResult<T>) {
  const extra = r.status === "error" ? ` [${r.error?.cause}] ${(r.error?.message ?? "").split("\n")[0]!.slice(0, 150)}`
    : ` ${r.items.length}${r.totalAvailable !== null ? `/${r.totalAvailable}` : ""} rows${r.truncated ? " (truncated)" : ""}`;
  console.log(`  ${leg.padEnd(16)} ${r.status.padEnd(6)} ${String(r.latencyMs ?? "-").padStart(6)}ms${extra}`);
}

// ---------------- tools ----------------

async function cmdTools(ids: ProviderId[]) {
  let failed = false;
  await mkdir(OUT_ROOT, { recursive: true });
  for (const id of ids) {
    const p = PROVIDERS[id];
    const t0 = performance.now();
    try {
      console.log(`[${id}] starting ${p.command} ${p.args.join(" ")} (first launch may install it)…`);
      const s = await McpSession.open(p);
      const connectMs = Math.round(performance.now() - t0);
      const tools = await s.listTools();
      await s.close();
      const needed = [p.tools.searchFlights, p.tools.searchHotels, ...p.tools.findPlace];
      await Bun.write(join(OUT_ROOT, `tools-${id}.json`), JSON.stringify(tools, null, 2));
      console.log(`[${id}] ${JSON.stringify(s.client.getServerVersion())} connect=${connectMs}ms tools=${tools.length}`);
      for (const n of needed) {
        const t = tools.find((x) => x.name === n);
        if (!t) failed = true;
        const req = (t?.inputSchema as { required?: string[] })?.required ?? [];
        console.log(`  ${t ? "OK     " : "MISSING"} ${n}  required=${JSON.stringify(req)}  readOnly=${t?.annotations?.readOnlyHint}`);
      }
    } catch (e) {
      failed = true;
      console.log(`[${id}] FAILED to start/connect: ${redactText((e as Error).message)}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

// ---------------- preflight ----------------

async function cmdPreflight(ids: ProviderId[]) {
  let all = true;
  for (const id of ids) {
    const r = await preflight(id);
    all &&= r.reachable;
    console.log(`[${id}] ${r.reachable ? "REACHABLE" : "UNREACHABLE"}`);
    for (const c of r.checks) console.log(`  ${c.host.padEnd(26)} dns=${c.dns} tls=${c.tls} ${c.ms}ms${c.error ? " :: " + c.error : ""}`);
  }
  process.exitCode = all ? 0 : 3;
}

// ---------------- run (scenario) ----------------

async function cmdRun(ids: ProviderId[]) {
  const S = SCENARIO;
  const force = process.argv.includes("--force");
  const rec = await Recorder.create("run", { scenario: S });
  const flights: (NormalizedFlight & { leg: string })[] = [];
  const hotels: NormalizedHotel[] = [];
  for (const id of ids) {
    console.log(`\n=== ${PROVIDERS[id].displayName} ===`);
    console.log("  starting server (first launch may install it, up to 90 s)…");
    const provider: TravelSearchProvider = McpTravelProvider.create(id, { onCall: rec.onCall });
    try {
      const h = await provider.healthCheck();
      for (const c of h.checks) console.log(`  health ${c.name.padEnd(34)} ${c.ok ? "ok" : "FAIL"}${c.detail ? " :: " + c.detail.slice(0, 120) : ""}`);
      await rec.step({ step: "health", ...h });
      if (!h.ok && !force) {
        console.log("  provider not healthy: searches NOT executed (use --force to call anyway)");
        continue;
      }
      for (const [leg, q] of [
        ["flight-outbound", { origin: S.iataFallback.origin, destination: S.iataFallback.destination, date: S.outboundDate, adults: S.adults }],
        ["flight-return", { origin: S.iataFallback.destination, destination: S.iataFallback.origin, date: S.returnDate, adults: S.adults }],
      ] as const) {
        const r = await provider.searchFlights(q);
        printResult(leg, r);
        await rec.step({ step: leg, query: q, ...summarize(leg, r) });
        flights.push(...r.items.map((f) => ({ ...f, leg })));
      }
      const hq = { city: S.destinationQuery, checkIn: S.checkIn, checkOut: S.checkOut, adults: S.adults };
      const hr = await provider.searchHotels(hq);
      printResult("hotels", hr);
      await rec.step({ step: "hotels", query: hq, ...summarize("hotels", hr) });
      hotels.push(...hr.items);
    } finally {
      await provider.close();
    }
  }

  // Deterministic package cost per provider (integer Toman). No LLM involved.
  const packages = ids.map((id) => {
    const pick = <T>(rows: T[], price: (r: T) => number | null, idf: (r: T) => string | null) => cheapest(rows, price, idf);
    const out = pick(flights.filter((f) => f.provider === id && f.leg === "flight-outbound"), (f) => f.totalPrice, (f) => f.providerFlightId);
    const ret = pick(flights.filter((f) => f.provider === id && f.leg === "flight-return"), (f) => f.totalPrice, (f) => f.providerFlightId);
    const hot = pick(hotels.filter((h) => h.provider === id), (h) => h.totalPrice, (h) => h.providerHotelId);
    const complete = out?.totalPrice != null && ret?.totalPrice != null && hot?.totalPrice != null;
    return {
      provider: id, complete, currency: "TOMAN",
      outbound: out && { id: out.providerFlightId, totalPrice: out.totalPrice, checkedAt: out.checkedAt },
      return: ret && { id: ret.providerFlightId, totalPrice: ret.totalPrice, checkedAt: ret.checkedAt },
      hotel: hot && { id: hot.providerHotelId, name: hot.name, totalPrice: hot.totalPrice, nights: hot.nights, checkedAt: hot.checkedAt },
      totalPrice: complete ? out!.totalPrice! + ret!.totalPrice! + hot!.totalPrice! : null,
      note: complete ? "whole-party flight fares + whole-stay one-room hotel price" : "incomplete: at least one leg has no priced result",
    };
  });
  await Bun.write(join(rec.dir, "normalized.json"), JSON.stringify({ flights, hotels }, null, 2));
  const ok = flights.some((f) => f.price !== null) && hotels.some((h) => h.totalPrice !== null);
  await rec.finish({ packages, result: ok ? "data_obtained" : "not_met" });

  console.log("");
  for (const pk of packages) console.log(`  package ${pk.provider}: ${pk.complete ? pk.totalPrice + " TOMAN" : pk.note}`);
  console.log(`\nArtifacts: ${rec.dir}/{report.json,normalized.json,raw/}`);
  console.log(ok ? "RESULT: real flight and hotel data obtained." : "RESULT: NOT MET — no real flight+hotel data obtained.");
  process.exitCode = ok ? 0 : 2;
}

// ---------------- live-check (bounded reliability cycles) ----------------

const FLIGHT_FIELDS = ["providerFlightId", "departureTime", "arrivalTime", "airline", "stops", "price", "totalPrice", "seatsLeft"] as const;
const HOTEL_FIELDS = ["providerHotelId", "name", "totalPrice", "providerPerNight", "stars", "rating", "refundable", "roomsLeft", "roomSleeps"] as const;

async function cmdLiveCheck(ids: ProviderId[]) {
  const cycles = numArg("--cycles", 3, 1, 3); // hard cap: at most 3 cycles per invocation
  const gapS = numArg("--gap-s", 60, 20, 600);
  const S = SCENARIO;
  const fq = { origin: S.iataFallback.origin, destination: S.iataFallback.destination, date: S.outboundDate, adults: 1 };
  const h3 = { city: S.destinationQuery, checkIn: S.checkIn, checkOut: S.checkOut, adults: 1 };
  const oneNightOut = new Date(Date.parse(`${S.checkIn}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const h1 = { ...h3, checkOut: oneNightOut };
  const rec = await Recorder.create("live-check", { cycles, gapS, queries: { flight: fq, hotel3: h3, hotel1: h1 } });
  console.log(`live-check: ${cycles} cycle(s), ${gapS}s apart; per cycle and provider: health + 1 flight + 2 hotel searches`);

  for (const id of ids) {
    const provider = McpTravelProvider.create(id, { onCall: rec.onCall });
    const prevFlightPrices = new Map<string, number>();
    try {
      for (let c = 1; c <= cycles; c++) {
        if (c > 1) await Bun.sleep(gapS * 1000);
        console.log(`\n[${id}] cycle ${c}/${cycles} @ ${new Date().toISOString()}`);
        const health = await provider.healthCheck();
        const failedChecks = health.checks.filter((x) => !x.ok);
        console.log(`  health ${health.ok ? "ok" : "FAIL"}${failedChecks.length ? " :: " + failedChecks.map((x) => `${x.name}: ${x.detail}`).join("; ") : ""}`);
        const cycle: Record<string, unknown> = { provider: id, cycle: c, health };
        if (health.ok) {
          const f = await provider.searchFlights(fq);
          printResult("flight", f);
          const a = await provider.searchHotels(h3);
          printResult("hotel 3 nights", a);
          const b = await provider.searchHotels(h1);
          printResult("hotel 1 night", b);
          const drift = f.items.filter((x) => x.providerFlightId && x.price !== null && prevFlightPrices.has(x.providerFlightId) && prevFlightPrices.get(x.providerFlightId) !== x.price).length;
          for (const x of f.items) if (x.providerFlightId && x.price !== null) prevFlightPrices.set(x.providerFlightId, x.price);
          const ratio = stayRatio(a.items, b.items);
          console.log(`  checks: flight price changes vs previous cycle=${c > 1 ? drift : "-"}; stay ratio 3n/1n median=${ratio.median?.toFixed(2) ?? "-"} (pairs ${ratio.pairs}, suspicious ${ratio.suspicious})`);
          Object.assign(cycle, {
            flight: { ...summarize("flight", f), nulls: nullCounts(f.items, FLIGHT_FIELDS), issues: f.items.flatMap((x) => x.issues),
              currencies: [...new Set(f.items.map((x) => x.currency))], priceBases: [...new Set(f.items.map((x) => x.priceBasis))],
              cheapest: cheapest(f.items, (x) => x.price, (x) => x.providerFlightId)?.price ?? null, priceChangesVsPrevious: c > 1 ? drift : null },
            hotel3: { ...summarize("hotel3", a), nulls: nullCounts(a.items, HOTEL_FIELDS), issues: a.items.flatMap((x) => x.issues),
              nights: [...new Set(a.items.map((x) => `${x.nights}/${x.providerNights}`))], priceBases: [...new Set(a.items.map((x) => x.priceBasis))],
              cheapest: cheapest(a.items, (x) => x.totalPrice, (x) => x.providerHotelId)?.totalPrice ?? null },
            hotel1: { ...summarize("hotel1", b), nulls: nullCounts(b.items, HOTEL_FIELDS), issues: b.items.flatMap((x) => x.issues),
              nights: [...new Set(b.items.map((x) => `${x.nights}/${x.providerNights}`))] },
            stayRatio: ratio,
          });
        }
        await rec.step(cycle);
      }
    } finally {
      await provider.close();
    }
  }
  const steps = rec.report.steps as { health: { ok: boolean }; flight?: { status: string }; hotel3?: { status: string }; hotel1?: { status: string } }[];
  const searches = steps.flatMap((s) => [s.flight, s.hotel3, s.hotel1].filter(Boolean)) as { status: string }[];
  const summary = {
    cycles: steps.length,
    healthFailures: steps.filter((s) => !s.health.ok).length,
    searches: searches.length,
    searchErrors: searches.filter((s) => s.status === "error").length,
    searchEmpty: searches.filter((s) => s.status === "empty").length,
  };
  await rec.finish({ summary });
  console.log(`\nsummary: ${JSON.stringify(summary)}\nArtifacts: ${rec.dir}/{report.json,raw/}`);
  process.exitCode = summary.searchErrors || summary.healthFailures ? 2 : 0;
}

const [cmd, providerArg] = process.argv.slice(2);
try {
  if (cmd === "tools") await cmdTools(selectProviders(providerArg));
  else if (cmd === "preflight") await cmdPreflight(selectProviders(providerArg));
  else if (cmd === "run") await cmdRun(selectProviders(providerArg));
  else if (cmd === "live-check") await cmdLiveCheck(selectProviders(providerArg));
  else {
    console.log("usage: bun run src/cli.ts <tools|preflight|run|live-check> [mrbilit|flytoday|all] [--force] [--cycles 1..3] [--gap-s N]");
    process.exitCode = 64;
  }
} catch (e) {
  console.error(redactText((e as Error).stack ?? String(e)));
  process.exitCode = 1;
}
