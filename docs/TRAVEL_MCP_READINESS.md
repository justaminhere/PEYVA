# PEYVA Phase 1.5: Travel Integration Readiness

- **Date:** 2026-11-20
- **Question:** Is `experiments/travel-mcp-spike/` a sound foundation for the first **educational** PEYVA MVP?
- **Inputs:** `docs/TRAVEL_MCP_FEASIBILITY.md`, the spike code, tests and evidence, two live runs, and one bounded 3-cycle live-check (§4.3).

## 1. Executive summary

**Recommendation: CONDITIONAL GO for the educational MVP.** This is not production or commercial readiness (see §10).

- **Verified:** MrBilit returned real Tehran→Kish flights and Kish hotels in 2 of 2 live runs and 3 of 3 live-check cycles,
  over about 4 hours: **22 of 22 provider calls** succeeded, with 0 normalization issues. The 3-night/1-night price ratio was 3.0
  (median of 20 hotels), so hotel prices really are for the whole stay. Currency (Toman) and price basis were confirmed against the
  provider docs, the server source, and the mrbilit.com website (one flight).
- **Improved:** 7 concrete defects fixed (§3). There is now a small `TravelSearchProvider` boundary that hides all MCP
  details. A bounded `live-check` command was added. Tests went from 19 to 35 + 2 live, and now include real recorded responses.
- **Risky:** a single unofficial provider; DNS instability (1 of 4 preflights on the developer's network); FlyToday unusable
  from that network; PolyForm Noncommercial license with informal educational permission only; dependencies not locked.

## 2. Current architecture

```
              application layer (Phase 2: Hono API / agent)
                          │  imports only ↓
   src/travel/provider.ts   TravelSearchProvider, FlightQuery, HotelQuery, SearchResult,
                            validate*Query, isFresh            + src/types.ts (Normalized*)
                          │
   src/travel/mcp-provider.ts  McpTravelProvider  (only file that knows tool names / slugs / city ids)
        │            │              │                 │
   src/mcp.ts   src/normalize.ts  src/resolve.ts   src/preflight.ts, src/diagnose.ts, src/sanitize.ts
   (SDK stdio)  (JSON → model)    (place pickers)  (health, error causes, redaction)
        │
   uvx mrbilit-mcp==0.5.2 / flytoday-mcp==0.4.2  (Python, unofficial site APIs)
```

Execution flow for one search:
1. Validate the query (dates in Tehran time, 1–30 nights, IATA format).
2. Open the MCP session lazily and reuse it.
3. Hotels only: resolve the city once via the provider's lookup tool, and cache it.
4. `tools/call` with a timeout.
5. Classify the outcome (`ok | tool_error | timeout | transport_error`).
6. Normalize.
7. Return a `SearchResult` with `status` `ok | empty | error`.

Provider problems never throw. `cli.ts` is a thin consumer of the boundary.

Reusable as-is: `mcp.ts`, `normalize.ts`, `travel/provider.ts`, `travel/mcp-provider.ts`, `sanitize.ts`, `diagnose.ts`.
Spike-only: `cli.ts`, `scenario.ts`, `preflight.ts` (hosts hard-coded per server version).

## 3. Code quality findings

| # | Finding | Severity | Status |
|---|---|---|---|
| D1 | `report.json` written only at the end: two interrupted runs (08:37, 08:51 UTC) left empty folders | High (evidence loss) | **Fixed**: written after every call and step, `finished` flag. Verified by killing a run mid-cycle |
| D2 | Truncation invisible: 26 hotels available, 20 returned; `matching` / `not_on_sale` dropped | High (silently incomplete) | **Fixed**: `totalAvailable`, `truncated`, not-on-sale note |
| D3 | MrBilit multi-direction fare: `destination` taken from the last segment (= the origin on a round trip) | Medium (latent) | **Fixed**: first segment only, row flagged `partial` |
| D4 | No date validation; `checkOut <= checkIn` divided by zero | Medium | **Fixed**: `validateHotelQuery`, `RangeError` in `normalizeHotels` |
| D5 | MrBilit's cheapest room can sleep fewer guests than the party (`cheapest_room_sleeps`) | Medium (wrong price for groups) | **Fixed**: `roomSleeps` field plus an issue when it's smaller than the party |
| D6 | `as any` for `leg` / `locationSource`; request params mutated after sending | Low | **Fixed** (removed in the CLI rewrite) |
| D7 | Provider-specific branching inline in `cli.ts`; no freshness rule | Medium (coupling) | **Fixed**: `TravelSearchProvider` + `isFresh` (15 min default) |
| R1 | `uvx --from mrbilit-mcp==0.5.2` pins the server but **not** its dependencies (`curl_cffi`, `httpx`, `mcp`) | Medium (reproducibility, supply chain) | Open, documented |
| R2 | Preflight hosts hard-coded from the 0.5.2/0.4.2 sources | Low | Open, documented |
| R3 | `resolve.ts` flight-code confirmers are no longer used by `run` (the boundary takes IATA codes) | Low | Kept (tested, small) |
| R4 | Flight times: MrBilit stamps `+03:30` on every time (upstream docs), FlyToday format unverified on real data | Low for domestic | Open |
| R5 | PEYVA folder is **not a git repository** | Medium (no history) | Open: first Phase 2 step |

No unnecessary dependencies: one runtime dependency (`@modelcontextprotocol/sdk` 1.32.2).

## 4. Real provider test results

### 4.1 Environment

Two environments, kept strictly apart:

| Where | Can reach providers? | Used for |
|---|---|---|
| Sandbox VM (Claude's shell, Ubuntu 22.04) | **No**: egress allowlist, no direct DNS | tests, typecheck, MCP discovery, CLI error paths |
| Developer machine `funlife` (Omarchy, Germany) | MrBilit yes, FlyToday API no | live runs, live-check |

### 4.2 Live runs before Phase 1.5 (VERIFIED)

`bun run src/cli.ts run mrbilit`, evidence in `experiments/travel-mcp-spike/evidence/2026-11-20-omarchy-live/`.

| Call | Run 1 (08:52 UTC) | Run 2 (12:34 UTC) |
|---|---|---|
| `mb_find_place` Tehran / Kish (flight) / Kish (hotel) | 2842 / 179 / 645 ms | 2560 / 355 / 897 ms |
| `mb_search_flights` THR→KIH 12-10 | 1324 ms, 5 flights (3 not on sale) | 830 ms, 5 flights |
| `mb_search_flights` KIH→THR 12-13 | 790 ms, 6 flights | 2381 ms, 6 flights |
| `mb_search_hotels` kish 12-10→13 | 3518 ms, 20 of 26 | 3290 ms, 20 rows |
| Cheapest package (deterministic) | 25,114,300 Toman | 25,114,300 Toman |

- Flights: the same 5 outbound flight numbers, prices and seat counts in both runs.
- Hotels: the cheapest two were unchanged. The third changed (Helia → Parsian), so hotel lists move within hours.

### 4.3 Bounded live-check (Phase 1.5): VERIFIED

`bun run live-check mrbilit` on the developer machine, 12:57:39–12:59:55 UTC. 3 cycles, 60 s apart, 10 provider requests in total.
Evidence: `evidence/2026-11-20-omarchy-live/live-check/`.

| Cycle | Health (TLS flight / hotel host, MCP) | Flight THR→KIH 12-10 | Hotels 3 nights | Hotels 1 night | Stay ratio 3n/1n |
|---|---|---|---|---|---|
| 1 | ok (509 / 340 ms, tools 2285 ms) | ok, 967 ms, 5/5, 3 not on sale | ok, 3728 ms, 20 of 28 | ok, 2992 ms, 20 of 28 | 20 pairs, median 3.00, min 2.67, max 3.00, 0 suspicious |
| 2 | ok (109 / 113 ms) | ok, 704 ms, 5/5 | ok, 814 ms, 20 of 28 | ok, 469 ms, 20 of 28 | same |
| 3 | ok (345 / 267 ms) | ok, 841 ms, 5/5 | ok, 424 ms, 20 of 28 | ok, 342 ms, 20 of 28 | same |

Summary: 3 of 3 health checks ok, **9 of 9 searches ok**, 0 errors, 0 empty. (The 1 lookup per session was also ok, 905 ms.)

- **Currency / basis:** all rows `TOMAN`; flights `per_adult`; hotels `whole_stay_one_room`; nights computed = provider (`3/3`, `1/1`).
- **Missing fields:** flights 0 nulls in 8 checked fields. Hotels `rating` null for 3 of 20 (unrated) and `roomsLeft` null for 20 of 20
  (MrBilit's search does not report it). Both stay `null`; nothing is filled in.
- **Stay ratio:** 17 of 20 hotels exactly 3.00. The 3 below 3 (Parmida 2.67, Beynolmelali 2.71, Kourosh 2.82) cost more for the single
  night of Thu 10 Dec than the average night of the 3-night stay. That is consistent with varying nightly rates and whole-stay totals.
  A per-night price mislabelled as whole stay would give about 1.0.
- **Stability:** the flight and hotel responses were byte-identical across the 3 cycles, including seat counts. The cheapest flight was 10,594,200
  and the cheapest 3-night hotel 3,726,000, the same as at 08:52 and 12:34. Hotels available grew from 26 (08:52) to 28.
- **Caching unknown:** hotel latency fell from 3.7 s to 0.4 s between cycles. The MCP server has no search cache (source checked), so this is
  either connection reuse or caching at MrBilit. `checkedAt` is **our** query time, not a guarantee that the provider's data is that fresh.

### 4.4 FlyToday

Unchanged from Phase 1: `api.flytoday.ir` resolves to the private address `172.22.3.13` on the developer network and the
connection is refused. **NOT TESTED** for searches. Root cause still open: geo-DNS versus a local resolver/VPN/Docker effect.

## 5. Reliability observations

- **Provider calls:** 22/22 succeeded (2 runs + 3 live-check cycles, 08:52–12:59 UTC, one network, one route). That is a few hours of
  evidence from one place, not proof of long-term reliability.
- **DNS:** `hotel.mrbilit.ir` failed once (`EAI_AGAIN` after 27 s) in 1 of 4 preflights on the developer network, then
  recovered within 10 minutes. A real application needs retry with backoff on DNS failure and a health status per backend host.
- **Latency:** lookups 0.2–2.8 s (the first call per session is slowest), flight search 0.7–2.4 s, hotel search 0.3–3.7 s (first
  search per session 3–3.7 s, repeated searches under 1 s).
  A full scenario takes about 10 s. Phase 2 should stream partial results and not block on all searches.
- **Cold start:** the first `uvx` launch on a machine installs about 35 packages. Pre-install it in setup, or the 90 s connect timeout may hit.
- **Single provider:** with FlyToday unavailable, there is no fallback. An outage of MrBilit's unofficial endpoints
  stops the travel scenario.

## 6. Data integrity and normalization

| Requirement | Evidence | Status |
|---|---|---|
| Flight prices consistent | `price` = per adult, `totalPrice` = party, integer Toman; recorded real responses pinned in `test/recorded/` | VERIFIED (MrBilit) |
| Hotel price basis explicit | `priceBasis: "whole_stay_one_room"`; provider nights = computed nights; `per_night_toman ≈ total/3` on all real rows; 3-night/1-night ratio median 3.00 over 20 hotels × 3 cycles | VERIFIED (MrBilit) |
| Currency | Toman per upstream docs and source (Rial // 10), and mrbilit.com shows the same value with "تومان" | VERIFIED (one cross-check) |
| Missing fields stay null | e.g. hotel `rating: null` kept; `nullCounts` reported per field in `live-check` | VERIFIED |
| Stale prices not presented as current | `checkedAt` on every row and result; `isFresh()` with a 15 min default. **The app layer must call it**: nothing enforces it at render time yet. Possible provider-side caching (§4.3) means `checkedAt` is the query time, not the data's age | PARTIAL (rule exists, enforcement is Phase 2) |
| Provider + timestamp preserved | `provider`, `checkedAt` on every row; raw calls with args and timestamps | VERIFIED |
| Empty ≠ error | `status: "empty"` vs `"error"` with `cause`; tested against the fake server | VERIFIED (unit) |
| Availability ≠ bookability | `availability: "listed"` = shown by the provider at `checkedAt`; nothing is held | VERIFIED (by design) |
| No invented URLs | `sourceUrl: null` everywhere (the search tools return none); tested | VERIFIED |
| No LLM in calculations | `cheapest()`, package sum, `stayRatio()`: integer/deterministic code with tests | VERIFIED |

## 7. Security and licensing

- **Secrets:** none required; none committed. Child processes get an env allowlist (no `*_MCP_PROXY`). Raw output is
  redacted (URL credentials, token/cookie/session/phone/email keys), and scans found nothing.
- **Untrusted content:** hotel names, addresses, provider notes (and in future reviews) are site content. In Phase 2
  they must reach the LLM as data in a delimited block, never as instructions, and must not drive tool calls by themselves.
- **Read-only:** only search and lookup tools are called. No booking, payment or account actions exist in the code.
- **Supply chain:** see R1. The servers use `curl_cffi` with Chrome TLS impersonation by default. The `[browser]` anti-bot
  extra is not installed.
- **License:** mrbilit-mcp / flytoday-mcp are **PolyForm Noncommercial 1.0.0**. The project owner reports that the MCP Farsi
  team raised no objection to use **for the Bozhan educational course**. This is informal permission for that purpose only.
  It is **not** a commercial license, and it is **not** authorization from MrBilit or FlyToday, whose terms of service remain
  unreviewed. Any commercial or public use needs a commercial license or official provider APIs.

## 8. Changes made in Phase 1.5

- `src/travel/provider.ts` (new): interface, query types, validation (Tehran-local "today", real dates, 1–30 nights), freshness.
- `src/travel/mcp-provider.ts` (new): `McpTravelProvider` with a per-provider adapter table, lazy session, city cache, `onCall` trace hook.
- `src/travel/checks.ts` (new): `stayRatio`, `nullCounts`.
- `src/normalize.ts`: D2, D3, D4, D5 (`totalAvailable`, `notOnSale`, first-segment mapping, nights guard, `roomSleeps`).
- `src/types.ts`: `roomSleeps`. `src/diagnose.ts`: `invalid_query` cause.
- `src/cli.ts`: rewritten on top of the boundary. Incremental `Recorder` (D1). New `live-check` (hard cap of 3 cycles, ≥ 20 s gap).
- Tests reorganized: `test/unit` (synthetic, 32), `test/recorded` (real recorded MrBilit, 3), `test/live` (real servers, 2), plus
  `test/support/fake-server.ts` (test-only `mb_*` tools on synthetic data).
- Evidence: second live run added (`evidence/2026-11-20-omarchy-live/run-mrbilit-2/`). Two empty folders from interrupted runs removed.

Validation after the changes (sandbox VM): `tsc` 0 errors; `bun run test` 35 pass / 0 fail; `bun run test:live` 2 pass;
`run mrbilit` health check correctly blocks searches with no network; `live-check --cycles 9 --gap-s 1` clamped to 3 cycles / 20 s;
an interrupted `live-check` kept `report.json` with `finished: false`.

## 9. Remaining risks

1. **Single unofficial provider.** Endpoints can change or block without notice. FlyToday is not a working fallback from this network.
2. **License scope.** Educational use only. Must be re-decided before any non-educational use.
3. **Reliability unknown beyond a few hours on one network.** DNS flakiness has been observed. Provider-side caching is possible but unconfirmed.
4. **Dependencies not locked** for the Python servers (R1).
5. **Freshness not enforced at render time.** Phase 2 must check `isFresh` before showing a price as current.
6. **No git history** (R5).
7. **Normalizer coverage:** only one-way domestic MrBilit shapes seen live. Round-trip packages, international flights and FlyToday rows are unverified.

## 10. Final engineering recommendation

**CONDITIONAL GO, as the foundation for the educational MVP**, with these documented limitations: MrBilit only, read-only,
domestic one-way flights + hotels, prices shown with their `checkedAt` and re-searched when older than 15 minutes, results
labelled "listed by MrBilit", and booking handed to the user on mrbilit.com.

- **Production readiness: NO.** Unofficial endpoints, single provider, no locked deps, no monitoring.
- **Commercial readiness: NO.** The license and provider ToS do not allow it today.
- **Phase 1.5 live condition: met.** The bounded live-check (§4.3) ran 3 cycles with 0 errors and a stay ratio of 3.00. All eight
  Definition-of-Done items are satisfied. Phase 2 can start under the limitations above.

## 11. Phase 2 blueprint: first conversational PEYVA MVP (not implemented)

Goal: a Persian conversation that turns "یه سفر سه‌روزه ارزون به کیش، دهم آذر" into a verified, priced trip comparison,
remembers stable preferences, and asks before any action.

```
apps/web        React + Vite + Tailwind (RTL, Persian). Chat + structured result cards (cards render tool data, not LLM text)
apps/api        Bun + Hono. POST /chat (SSE stream), GET /searches/:id, POST /approvals/:id
packages/agent  agent loop: LLM call → tool calls → results → reply; goal extraction; approval gate
packages/travel this boundary (moved from the spike unchanged): TravelSearchProvider + McpTravelProvider
packages/db     PostgreSQL + Drizzle
```

- **Goal extraction:** the LLM produces a typed `TripGoal` (origin, destination, dates, nights, travelers, budget, preferences,
  unknowns[]) via structured output, validated with the same validators. Missing fields lead to one clarifying question, not guesses.
- **Tools exposed to the LLM:** `search_flights`, `search_hotels` (thin wrappers over the boundary), `compare_trip` (deterministic
  package cost and ranking in code), `remember_preference`, `propose_action`. The LLM never computes prices. It cites result ids.
- **Memory (minimal):** table `preferences(user_id, key, value, source_message_id, confirmed_at)`. Written only after the user confirms
  ("همیشه پرواز صبح؟ ذخیره کنم؟"). Loaded into the prompt as data.
- **Persistence:** `users`, `conversations`, `messages`, `tool_calls` (audit: args, status, latency), `search_snapshots`
  (normalized rows + `checkedAt`), `approvals` (proposed action, status, decided_at).
- **Approved actions in the MVP:** non-transactional only, e.g. "watch this route and notify me", or "open mrbilit.com for this flight".
  No booking or payment.
- **Safety:** provider text is fenced as untrusted. `isFresh` is checked before rendering a price as current. Every price card shows
  its provider and time.
- **Milestones (short sessions, each ends with visible output):**
  1. `git init` and move `packages/travel`.
  2. Goal extraction CLI: Persian text → `TripGoal` JSON.
  3. Tool loop CLI: goal → searches → `compare_trip` → Persian answer.
  4. Hono `/chat` with SSE.
  5. React chat with result cards.
  6. Postgres + Drizzle: snapshots, tool_calls.
  7. Preferences memory with confirmation.
  8. Approval flow for "watch route".
