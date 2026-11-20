# travel-mcp-spike — PEYVA Phase 1

A minimal Bun + TypeScript CLI that proves PEYVA's own code can drive the unofficial Iranian
travel MCP servers **mrbilit-mcp** and **flytoday-mcp** over stdio. It runs a fixed
Tehran → Kish scenario, normalizes results into a small internal model, and records evidence.

Read-only. No booking, no login, no mock fallback. A provider failure is reported as a failure.

Findings: [`docs/TRAVEL_MCP_FEASIBILITY.md`](../../docs/TRAVEL_MCP_FEASIBILITY.md) (Phase 1) and
[`docs/TRAVEL_MCP_READINESS.md`](../../docs/TRAVEL_MCP_READINESS.md) (Phase 1.5).

## Requirements

| Tool | Tested with | Why |
|---|---|---|
| Bun | 1.4.5 | runs the CLI and tests |
| uv / uvx | 0.13.4 | launches the pinned Python MCP servers (`uvx --from mrbilit-mcp==0.5.2 …`) |
| Network | PyPI + the providers' hosts (see `src/preflight.ts`) | live searches |

On Omarchy/Arch: `sudo pacman -S uv`, and install Bun from https://bun.sh. The servers' Python
dependencies are installed by `uvx` on first launch (about 40 s cold, then cached).

The `[browser]` extra of the upstream servers (headless bot-check clearing) is **not** installed,
on purpose.

## Commands

```bash
cd experiments/travel-mcp-spike
bun install --frozen-lockfile

bun run test                   # unit (synthetic) + recorded (real MrBilit responses); no network
bun run test:live              # launches the REAL servers via uvx and checks tools/list (needs uv + PyPI)
bun run typecheck

bun run tools                  # MCP discovery for both servers, schemas -> output/tools-*.json
bun run preflight              # DNS + TCP + TLS to each provider backend (sends no HTTP request)
bun run spike                  # Tehran->Kish scenario through TravelSearchProvider (health first)
bun run src/cli.ts run mrbilit # one provider only; --force searches even if health fails
bun run live-check mrbilit     # bounded reliability check: max 3 cycles (default), >= 20 s apart (default 60)
```

Exit codes: `run` 0 = real flight **and** hotel data obtained, 2 = not obtained; `live-check` 0 = no errors,
2 = a health check or search failed; `preflight` 3 = a backend is unreachable; 1 = crash.

Test tiers:

| Folder | Data | Network |
|---|---|---|
| `test/unit/` | SYNTHETIC fixtures and a test-only fake MCP server (`test/support/`) | none |
| `test/recorded/` | REAL MrBilit responses recorded 2026-11-20 (`test/fixtures/recorded/`) | none |
| `test/live/` | real servers via uvx (discovery only) | PyPI |

Live provider searches are never part of `bun test`. They run only through `run` / `live-check`.

### Before a live run

- `preflight` and `healthCheck` connect directly, like the servers do (they ignore `HTTPS_PROXY` by design).
  Passing it does not prove searches will work: a geo-block or bot check can still answer after the TLS handshake.
- FlyToday rate-limits searches per IP (about 15 flight searches; the hotel search asks for a captcha after
  about 12 searches in 10 minutes and blocks for an hour or more). Don't loop `run` or `live-check`.
- This project never sets `MRBILIT_MCP_PROXY` / `FLYTODAY_MCP_PROXY`. Routing provider traffic through a
  third-party proxy to get around a regional block is a terms-of-service decision, not a default.

## Using the provider boundary

```ts
import { McpTravelProvider } from "./src/travel/mcp-provider.ts";
import { isFresh } from "./src/travel/provider.ts";

const p = McpTravelProvider.create("mrbilit");
const r = await p.searchHotels({ city: "کیش", checkIn: "2026-12-10", checkOut: "2026-12-13", adults: 1 });
if (r.status === "ok" && isFresh(r.checkedAt, new Date())) { /* r.items: NormalizedHotel[] */ }
await p.close();
```

The app layer imports only `src/travel/provider.ts` (interface, query types, validation, freshness) and `src/types.ts`.

## Scenario (`src/scenario.ts`)

Tehran → Kish Island, out 2026-12-10, back 2026-12-13; hotel 2026-12-10 → 2026-12-13 (3 nights);
1 adult, 1 room. Dates are Gregorian `YYYY-MM-DD`, which both servers require.

Steps per provider (`run`):
1. `healthCheck()`: DNS/TLS to the backends and the required MCP tools. Searches are skipped if it fails (unless `--force`).
2. Two one-way flight searches with IATA codes THR/KIH.
3. One hotel search. The provider resolves "کیش" with its own lookup tool, and the result is used **only** when exactly
   one city matches.
4. The cheapest complete package is summed with integer arithmetic (Toman). No LLM is involved.

`live-check` per cycle and provider: health, 1 flight search, a 3-night and a 1-night hotel search. It reports latency,
status, null-field counts, issues, price changes between cycles, and the 3-night/1-night price ratio per hotel
(about 3 means `totalPrice` really is the whole stay).

## Output

`output/run-<timestamp>/` and `output/live-check-<timestamp>/` (git-ignored), written **as the run progresses**
(`finished: false` marks an interrupted run):
- `report.json`: steps (health, application-level search summaries) and every provider call with args, timestamp, latency, outcome
- `normalized.json`: `NormalizedFlight[]` and `NormalizedHotel[]` (`src/types.ts`)
- `raw/<provider>-NN-<tool>.json`: the redacted raw response or error, plus the server's stderr tail

Evidence: `evidence/2026-11-20-sandbox/` (failed, sandbox) and `evidence/2026-11-20-omarchy-live/` (two VERIFIED live runs).

## Money and units

Both servers return Toman in `*_toman` fields. They convert from the API's Rial with integer division by 10.
The model keeps `currency: "TOMAN"` on every row. `tomanToRial()` is the only conversion.

- Flights: `price` = one adult's fare (taxes included); `totalPrice` = the whole party.
- Hotels: `totalPrice` = cheapest room for the **whole stay, one room**. `nights` is computed from the dates and
  cross-checked against the provider's `nights` and `per_night_toman`. MrBilit documents that hotel prices do
  not depend on the guest count.
- `sourceUrl` is `null`: neither search tool returns a booking URL, and the spike does not construct one.
- `rating`: MrBilit is 0–5 (documented). FlyToday's `score` scale is undocumented, so `ratingScale` is `null`.

## Layout

```
src/travel/provider.ts      TravelSearchProvider interface, query validation, freshness  (app-facing)
src/travel/mcp-provider.ts  McpTravelProvider: the only place that knows MCP tool names and provider ids
src/travel/checks.ts        deterministic data-quality checks (stay ratio, null counts)
src/cli.ts         commands: tools | preflight | run | live-check
src/mcp.ts         MCP stdio session (official SDK), timeouts, outcome classification
src/providers.ts   pinned server versions and tool names
src/preflight.ts   backend host reachability (hosts read from the pinned upstream sources)
src/resolve.ts     strict location pickers for find-place results
src/normalize.ts   provider JSON -> NormalizedFlight / NormalizedHotel, cheapest()
src/diagnose.ts    failure cause heuristics (network/geo, timeout, rate limit, anti-bot, schema, …)
src/sanitize.ts    redaction of secrets in raw output
test/              unit/ (synthetic), recorded/ (real recorded), live/ (opt-in); support/fake-server.ts is test-only
```

## License note

mrbilit-mcp 0.5.2 and flytoday-mcp 0.4.2 are under **PolyForm Noncommercial 1.0.0**. This spike only runs
them as external processes for personal R&D. Any commercial use of PEYVA on top of them needs a commercial
license from the author. See the feasibility report.
