# PEYVA Phase 2A: Conversational Agent Core

- **Date:** 2026-11-20
- **Status: PARTIAL.** The agent core is implemented and tested. Live LLM execution is **NOT VERIFIED**: no runtime API key is
  configured yet. The live run of the tool layer against MrBilit is pending on the developer machine (§4).

## 1. What was built

A Bun + TypeScript agent core that runs this flow:

```
Persian message
  → LLM (OpenAI-compatible, function calling) reports what the user said   ──┐ bounded loop:
  → update_trip_goal: zod-validated GoalPatch → deterministic merge          │ ≤ 6 LLM calls
  → analysis: missing fields / conflicts / assumptions to confirm            │ ≤ 12 tool calls
  → LLM asks ONE short question, or …                                         │ ≤ 9 provider searches
  → compare_trip_options: bounded real searches (TravelSearchProvider)       │ per user message
  → deterministic comparison engine (integer Toman)                         ──┘
  → CLI prints the comparison table itself + the LLM's short Persian reply + guard warnings
```

| Path | Role |
|---|---|
| `src/goal/schema.ts` | `GoalPatch` (what the LLM may send, "as stated") and `TripGoal` (merged, normalized state) |
| `src/goal/persian.ts` | Persian/Arabic digits, amounts ("۱۵ میلیون و ۵۰۰ هزار", "بیست میلیون"), Rial→Toman |
| `src/goal/dates.ts` | Jalali↔Gregorian via ICU `persian` calendar, month windows, relative days in Asia/Tehran |
| `src/goal/state.ts` | `applyPatch` (multi-turn merge), `analyze` (missing / conflicts / disclosures / bounded plan) |
| `src/compare/engine.ts` | deterministic comparison: eligibility, capacity, stars, budget, freshness, truncation |
| `src/agent/tools.ts` | the 4 tools, argument validation, search cache, budget, circuit breaker |
| `src/agent/agent.ts`, `prompt.ts`, `guards.ts`, `untrusted.ts` | bounded LLM loop, system prompt, output guards, provider-text fencing |
| `src/llm/types.ts`, `src/llm/openai-compatible.ts` | provider-independent `LlmClient`; the one real adapter (official `openai` SDK) |
| `src/travel/index.ts`, `src/travel/places.ts` | re-export of the Phase 1.5 boundary; city → IATA table |
| `src/render/fa.ts`, `src/cli/*` | Persian rendering; `peyva:chat`, `peyva:tools-check` |

Reused unchanged from Phase 1.5: the MCP client, normalization and `TravelSearchProvider` / `McpTravelProvider`. One small boundary
change: `FlightQuery.children` (optional, passed to the provider so `total_toman` covers the whole party).

## 2. Design decisions

1. **The LLM reports, code decides.** The LLM fills a `GoalPatch` with what the user said, as stated: a Jalali month *without* a
   year, the budget words verbatim. Code converts dates, digits and money, and decides what is missing. So the LLM never does calendar
   or money arithmetic, and a wrong conversion can't silently become a search.
2. **Nothing invented.** Origin, dates, travellers, budget and rooms are never defaulted. The single exception is derived, not
   invented: 1 traveller → 1 room. A year PEYVA infers (for example "۱۰ دی") is held as a *pending assumption*, and searching is blocked
   until the user confirms it. "The date doesn't matter" does not create a range; PEYVA asks for a rough month.
3. **Unit and scope disclosures.** A budget without a unit is read as Toman (normal Iranian usage) and disclosed. Rial is converted
   (÷10). A budget without a stated scope counts as the trip total and is disclosed. Implausibly small budgets (< 100,000 Toman) are a
   conflict, because they suggest a Rial/Toman mix-up.
4. **`compare_trip_options` runs the searches itself.** Once the goal is ready, the LLM calls one tool. Code derives the dates
   (fixed, or at most 3 candidates from a flexible range: start / middle / end), searches through the boundary, reuses fresh results,
   re-searches results older than 15 min, and compares. Ad-hoc `search_flights` / `search_hotels` exist with the same validation.
5. **Prices come from code only.** The CLI prints the comparison table from the engine. The LLM is told to refer to options by
   number. A **price guard** flags any money-like figure in the LLM's text that no tool produced. An **action guard** flags claims of
   booking, payment, reminders or monitoring. There are no such tools, and unknown tool names are rejected.
6. **Untrusted provider text.** Hotel and airline names and provider notes are cleaned (control and bidi-override characters
   removed, length capped) and fenced as `untrusted_provider_data` in tool results. The system prompt says to never follow them.
7. **Honest failure.** LLM errors (auth, rate limit, timeout, network, bad request, malformed) produce a Persian error line, never a
   made-up answer. A provider access problem (geo/network block, rate limit, bot challenge) stops further searches for the session.
   Empty ≠ error ≠ not searched.
8. **One adapter type, many providers.** `openai-compatible` covers OpenAI, OpenRouter, Gemini's OpenAI endpoint and local servers by
   base URL. `LlmClient` is a 1-method interface, so a native adapter (for example Anthropic) can be added without touching the agent.

## 3. Comparison rules (deterministic, `src/compare/engine.ts`)

- Flights must be priced and `listed`, on the right route and date, with seats not known to be fewer than the party. Unknown seat
  counts are allowed but warned about. Rows with data issues are excluded.
- Hotels must be priced, for exactly the candidate's check-in, check-out and nights, with stars ≥ minimum (unknown stars excluded when a
  minimum is set), and room capacity × rooms ≥ travellers when capacity is stated. Price = one-room whole-stay price × rooms, with a warning that
  N identical rooms are assumed and their availability is unconfirmed.
- Package = cheapest eligible outbound + return + each of the 3 cheapest eligible hotels, in integer Toman, marked within/over
  budget (per-person budgets × travellers). Over-budget options are labelled, never hidden.
- An error leg → `incomplete` with the reason; an empty leg → "provider listed nothing"; truncated provider lists are reported;
  stale legs → `stale`, ranked after fresh ones and labelled "not current" in the table. `checkedAt` and the provider are kept on every pick.

## 4. Verification

| Item | Evidence | Status |
|---|---|---|
| Persian goal extraction **by a real LLM** | needs a configured key | **NOT VERIFIED** |
| Multi-turn clarification + merge | `test/agent.test.ts` (the spec's 3-turn dialogue), `test/goal-state.test.ts` | VERIFIED (scripted LLM) |
| Goal validated before any tool runs | compare before ready → rejected, 0 provider calls; 6 kinds of invalid tool calls rejected, 0 provider calls | VERIFIED (unit) |
| Uses the existing real MCP integration | `McpTravelProvider` via `src/travel/index.ts`. `peyva:tools-check` reached `mb_search_flights` in the sandbox and got the expected network block | VERIFIED wiring; live data **PENDING** on Omarchy |
| Real flight + hotel data | recorded real MrBilit responses (2026-11-20) through the whole agent → 25,114,300 Toman, equal to the Phase 1 hand check | VERIFIED on recorded data; live re-run PENDING |
| Deterministic package arithmetic | `test/compare.test.ts`: stars, capacity, rooms ×2, budget, seats, not-on-sale, truncation | VERIFIED |
| Comprehensible Persian result | rendered table checked in tests (Jalali dates, Persian digits and separators, provider, check time, "نه رزرو") | VERIFIED (render) |
| Honest errors and stale data | LLM timeout/auth/429/malformed/network (real adapter against a local test server); stale re-search after 15 min; circuit breaker | VERIFIED |
| Prompt injection in provider content | injected hotel name with a bidi override: fenced, cleaned, a "book_hotel" call it provokes is rejected, numbers unchanged | VERIFIED (unit) |
| Unauthorized actions | unknown tools (book, alert) rejected; false booking claim → visible warning | VERIFIED (unit) |
| No mock presented as live | `peyva:chat` exits 2 without config; the scripted LLM and fake servers live only in `test/support/` | VERIFIED |

Executed in the sandbox VM (2026-11-20):
- `bun run typecheck`: 0 errors in root and spike.
- `bun run test:all`: 43 + 35 pass.
- `bun run test:live` (spike): 2 pass.
- `bun run peyva:chat` without `.env`: exit 2, with the missing-variable message.
- `bun run peyva:tools-check`: health "unhealthy" (sandbox DNS), the first search gave `network_or_geo_block`, further searches stopped,
  and an honest "نتیجهٔ کامل نشد" table was printed. Exit 2.

Fixtures and test doubles (never used at runtime):
- **Recorded real** MrBilit responses: `experiments/travel-mcp-spike/test/fixtures/recorded/`, served by `test/support/recorded-provider.ts`.
  It shifts recorded flight dates onto the requested day, so prices on other days in tests are not real prices for those days.
- **Synthetic** fixtures and the fake MCP server from Phase 1.5.
- **TEST-ONLY scripted LLM** (`test/support/scripted-llm.ts`) and a TEST-ONLY local OpenAI-compatible HTTP server inside
  `test/llm-adapter.test.ts`.

## 5. Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `PEYVA_LLM_BASE_URL` | yes | OpenAI-compatible endpoint, https (http only for localhost) |
| `PEYVA_LLM_API_KEY` | yes | API key; read from env / `.env` only, never logged or committed |
| `PEYVA_LLM_MODEL` | yes | a model with tool calling and good Persian |
| `PEYVA_LLM_TIMEOUT_MS` | no | default 45000 |

Template: `.env.example`. `.env` and `.env.*` are git-ignored.

## 6. Commands

```bash
cd ~/Work/PEYVA
bun install                          # root: zod, openai (+ experiments/travel-mcp-spike: bun install)
bun run typecheck                    # root + spike
bun run test                         # agent core (no network, no LLM)
bun run test:all                     # + spike unit/recorded tests
bun run peyva:tools-check            # LIVE provider, NO LLM: Tehran->Kish 1405-09-19, 3 nights, 1 adult
bun run peyva:tools-check --stars 4 --adults 2 --rooms 1 --budget "۴۰ میلیون"
cp .env.example .env && $EDITOR .env # add an LLM key
bun run peyva:chat                   # LIVE: real LLM + real provider. /goal, /reset, خروج
```

Session logs (JSONL, git-ignored): `output/sessions/`.

## 7. Known limitations

- 12 domestic cities. Only THR and KIH airport codes are verified against MrBilit. Unknown cities are reported, not guessed.
- MrBilit only. Flights are domestic one-way legs. Hotels price one room for the whole stay, and room counts > 1 assume identical rooms.
- Flexible dates check at most 3 departure days, which is explicitly stated. No price-calendar optimisation.
- Relative dates: today, tomorrow, the day after, and "in N days". "Next week" / "weekend" are not resolved yet; the LLM must ask.
- The price guard is a heuristic (figures ≥ 100,000; 0.5% tolerance). The action guard is a Persian regex. Both warn; they don't block.
- The quality of Persian understanding depends on the chosen model and has not been measured.
- Session state is in memory only. Monitoring requests are recorded in the session and answered with an explicit "not implemented".
- The root `typecheck` reuses the spike's TypeScript and `@types/bun`, because the registry fetch for `@types/bun` hung in the sandbox.

## 8. Remaining risks

1. **No live LLM run yet.** The biggest open question is whether a real model follows the "report as stated" contract in Persian.
2. Single unofficial provider; FlyToday is unreachable; license is educational-use only (see the readiness report).
3. Model behaviour drift: tool-calling quality differs between providers and models behind the same API shape.
4. Cost and latency: up to 6 LLM calls per message, plus about 10 s of provider searches for a full comparison.

## 9. Recommendation for Phase 2B

Close Phase 2A first: set a key and run `bun run peyva:chat` with 5 of the spec's Persian test sentences. Keep the transcripts in
`output/sessions/` and promote 2–3 sanitized ones to `evidence/` as the first live LLM evidence. Then, for Phase 2B:
1. A small evaluation set: 20 Persian requests with the expected `GoalPatch`, run against the configured model and scored deterministically.
2. Hono `/chat` (SSE) over the same `runTurn`.
3. Postgres + Drizzle for sessions and `tool_calls` audit.
4. A React chat that renders the engine's table as cards.
