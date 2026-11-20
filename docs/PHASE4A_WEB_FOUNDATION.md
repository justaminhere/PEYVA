# Phase 4A: chat-first local web foundation

Status: implemented. Offline tests and a VM smoke test pass. **End-to-end with the real LLM and live MrBilit: see §6.**

## 1. What it is (and is not)

A local-only browser UI for the existing PEYVA agent. You talk to the agent the same way as in the terminal, and the page adds only the pieces that the conversation showed to be needed:

- **Live progress of the turn:** what the agent is doing, and each real search with its result count.
- **The agent's words as they are generated.**
- **Ticket cards for options:** built from the deterministic comparison engine. They are never parsed from the LLM's text.
- **An approval panel:** the explicit "activate monitoring?" decision.
- **A goals panel:** monitoring goals and their last checks, read from PostgreSQL, with pause, resume and cancel.

It is not a dashboard, a search form or a booking site. There is no booking, no payment, no public deployment and no multi-user API.

## 2. Architecture

```
browser (React, RTL)  ──fetch/SSE──▶  Hono on Bun (127.0.0.1)  ──▶  handleMessage / runTurn (agent core, unchanged rules)
   web/src/*                          src/web/app.ts                   ToolRunner → MrBilit MCP (read-only)
                                      src/web/server.ts                GoalService / PreferenceStore / ConversationStore → PostgreSQL
```

The web layer adds no business logic. It reuses the following:

| need | reused from |
|---|---|
| a turn, approvals by text, slash commands | `handleMessage` (Phase 3) |
| approval button | `decidePending`, the same function the typed «بله» uses (refactored out of `resolvePending`) |
| cards | `src/render/cards.ts`, a structured twin of the terminal renderer that uses the same `fa()` rules, formatters and freshness check |
| goal status | `GoalService.list/get/lastChecks`, `STATUS_FA`/`CHECK_FA` from the CLI commands |
| live progress | new optional `TurnHooks` on `runTurn` (`onLlmCall`, `onTextDelta`, `onToolStart`, `onToolDone`) |
| streaming text | new `LlmClient.stream()` in the OpenAI-compatible adapter (SSE from the provider; tool-call fragments assembled by index; falls back to the non-streaming request only if the provider rejects streaming before sending anything) |

**Streaming semantics.** The text the user sees while it streams is the model's real output. The final `reply` event replaces it with the authoritative text after the deterministic guards have run. Guard warnings (unverified prices, dates, false claims of actions) appear under the reply, exactly as in the terminal.

**SSE events of `POST /api/chat`.** In order: `accepted`, then any number of `llm` / `delta` / `tool_start` / `tool_done`, then `cards` (only when the comparison was recomputed), then `reply`, `state` (pending approval and goals from the DB) and `done`. A comment ping is sent every 8 s during long searches.

**Other endpoints:**
- `GET /api/state` returns the transcript from PostgreSQL, the last cards, the pending approval and the goals. It is used on page reload.
- `POST /api/approval {decision, goalId|key}`
- `GET /api/goals`, `GET /api/goals/:id`, `POST /api/goals/:id/(pause|resume|cancel)`
- `POST /api/reset`

## 3. Safety of the local server

- **Binding:** it listens only on `127.0.0.1` (or `::1` / `localhost`). Any other `PEYVA_WEB_HOST` is refused at startup.
- **Request checks:**
  - **Every request:** the `Host` header must match exactly (blocks DNS rebinding).
  - **Every write:** `Content-Type: application/json` is required, a present `Origin` must be the app's own origin, and `Sec-Fetch-Site: cross-site` is refused. There are no CORS headers, so other websites cannot call the API.
- **Response headers:**
  - The page is served with a strict CSP (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`).
  - Every response also carries `nosniff`, `no-referrer` and `X-Frame-Options: DENY`.
  - Fonts are bundled, so the page makes no third-party requests.
- **Assets:** static files are served only by exact file name under `/assets`. Traversal attempts fall through to `index.html`.
- **Single-user mode:**
  - There is one agent session per server process, and turns are serialized (tested with 3 concurrent messages).
  - The approval hash never leaves the server.
  - An approval click must name the goal or preference that is pending *now*. A stale screen gets HTTP 409.
- **No simulated mode:** without LLM configuration or a database, the server does not start.

## 4. How to run

Prerequisites: `.env` as for the chat (`PEYVA_LLM_*`, `PEYVA_DATABASE_URL`), with PostgreSQL running (`bun run db:start`).

```bash
bun install
bun run web:build      # builds web/dist
bun run peyva:web      # http://127.0.0.1:4317  (PEYVA_WEB_PORT to change)
bun run peyva:worker   # optional, separate terminal: background checks of activated goals
```

**UI development:** run `bun run peyva:web` and, in a second terminal, `bun run web:dev`. Then open http://127.0.0.1:5173, which proxies `/api` to the server on 4317.

**Checks:**
- `bun run test` runs the server tests, then the UI tests.
- `bun run test:all` also runs the spike tests.
- `bun run typecheck` covers the server, the web code and the spike.

## 5. Tests (verified)

All test runs below use a real embedded PostgreSQL 18 and recorded MrBilit data. The LLM in tests is a **TEST-ONLY** scripted LLM, in a streaming variant where streaming matters. It is never used by the app.

- **`test/llm-stream.test.ts` (4 tests).** These run the real streaming adapter against a fake endpoint that speaks the OpenAI SSE wire format:
  - text deltas and usage
  - tool calls split across chunks
  - 429 mapped to `rate_limit`
  - hooks order in a real turn with auto-compare
- **`test/web-api.test.ts` (8 tests):**
  - **Streaming:** the full SSE event order, the live text equal to the final text, cards with the real recorded total of 25,114,300 Toman and flight ZV 4030, and the approval question sent separately from the LLM's words.
  - **Approval:** a stale click gets 409, an approval activates the goal in the DB and the reply is built from the row; approve, reject, and a typed «بله» that never reaches the LLM.
  - **Reload and reset:** the transcript reloads from PostgreSQL, and reset keeps the goals.
  - **LLM failure:** shown as an error, never as an answer.
  - **Concurrency and guard:** serialized turns; Host, Origin, cross-site and content-type rejections; no CORS.
- **`web/test/app.test.tsx` (6 tests).** The real React app (happy-dom) talks to the real server in-process:
  - progress, final text and ticket cards from real results
  - the approval panel, where «فعال کن» activates the goal in the DB and the goal panel shows «فعال» and the next check; pause
  - «فعال نکن» cancels the draft
  - an LLM error is shown as an error
  - reload restores the transcript and the cards
  - the SSE reader handles chunk boundaries and pings
- **Totals:** 122 server tests, 6 UI tests and 35 spike tests pass. `bun run typecheck` is clean. `web:build` succeeds: 236 kB JS (74 kB gzip).
- **VM smoke test** (real server process, real embedded PostgreSQL):
  - health and SPA routes return 200, assets are served with the right types and CSP is present
  - a foreign `Host` gets 403, a foreign `Origin` gets 403, and binding to `0.0.0.0` is refused
  - `POST /api/chat` with the real Groq adapter streamed `accepted → llm → reply(network error, shown honestly) → state → done`, because the VM cannot reach Groq

## 6. End-to-end on the developer machine

Pending: a real conversation in the browser on Omarchy, with the real LLM, live MrBilit and real PostgreSQL.

## 7. Limitations

- **Single user and single session per server process:** a second tab shares the same conversation.
- **Process-bound state:** the transcript survives a reload (it is in PostgreSQL). The agent's working memory (current trip goal, LLM context) does not survive a server restart.
- **Partly Latin progress labels:** search lines come from the terminal renderer, so they still show route codes and ISO dates (`THR→KIH 2026-12-10`).
- **One provider, one goal type:** the same as Phase 3.
- **Interim text during tool calls:** text streamed during an iteration that ends in tool calls is discarded from the view when the tools start. Only the final answer stays.
- **No browser-engine tests:** UI tests run in happy-dom, not a real browser. Layout and RTL are checked manually (§6).

## 8. Next UX milestone (Phase 4B, proposal)

Watch real conversations and keep only the UI that earned its place:

1. **Candidate dates side by side.** For flexible ranges ("sometime in Bahman"), compare the cheapest option per date without reading three tickets.
2. **Inline edits on the trip goal.** Tap the budget or the nights in a small summary chip to change them, then have the agent re-run. This saves a round of typing.
3. **In-app alerts in the conversation.** When the worker finds a match, show it as a ticket the next time the page opens, with "what changed since last time".

Each item should be justified by a moment in a real session log (`output/sessions/web-*.jsonl`) where text alone was clumsy.
