# Phase 4A: end-to-end verification and stabilization

Date: 2026-11-20 (Tehran evening). Scope: verification and fixes only. No Phase 4B work.

## Decision: CONDITIONAL GO

The web app works in a real browser against real PostgreSQL, real MrBilit (through the worker) and the real Groq endpoint. Several things were verified live:

- goal approval, pause, resume, budget change with re-approval, and reject/cancel
- reload, server restart and conversation resume
- the 5173 dev proxy
- the mobile layout
- a real Telegram match alert

**Not verified:** one full user conversation with the real LLM that ends in streamed text and result cards in the browser. Groq's daily token quota for the configured model was exhausted after the first LLM request of the scenario (details in §3).

**Condition for Phase 4B:** the §3 scenario passes once with the real LLM.

## 1. Environment

| | |
|---|---|
| Machine | developer's Omarchy Linux (server, PostgreSQL, worker, browser). Tests and builds also ran in the Linux VM of the Claude desktop app, whose network cannot reach Groq or MrBilit. |
| Runtime | Bun 1.4.5. Builds: Vite 8.3.8, Tailwind 4.3.5, React 19.3.1, Hono 4.13.19 |
| LLM | Groq OpenAI-compatible endpoint, model `qwen/qwen3.8-27b` (key present in `.env`; its value was never read) |
| Database | embedded PostgreSQL 18 (`bun run db:start`, port 54329). Migrations 0000 and 0001 were applied automatically by the server. |
| Travel | MrBilit MCP (`mrbilit-mcp` via uvx), read-only |
| Browser | the Claude desktop app's built-in browser pane (Chromium-based), driven by Claude: desktop 1280×720 and mobile emulation 375×812. Firefox and Playwright were not available to the agent. |

## 2. Commands executed

On Omarchy (by the developer):

```bash
bun install && bun run web:build && bun run peyva:web     # three times: initial, after fix 1, after fixes 2–6
bun run web:dev                                          # Vite dev server on 127.0.0.1:5173
bun run peyva:goals create --origin تهران --destination کیش --depart "۱۹ آذر ۱۴۰۵" --nights 3 --adults 1 --rooms 1 --stars 2 --budget "۳۰ میلیون"   # answered «بله»
bun run peyva:worker --once
```

In the VM (by Claude):

```bash
git status; bun run typecheck; bun run test; bun run test:all; bun run web:build
bun x drizzle-kit generate --name conversation_state
```

In the browser (by Claude): the §3 message; the `/goals` and `/budget 2 …` commands; the approval buttons; pause, resume and cancel; reloads; `fetch` probes of `/api/*` on both ports.

## 3. Real LLM (Groq)

| Attempt | Result |
|---|---|
| Scenario message: «می‌خوام از تهران برم کیش، ۱۰ تا ۱۳ دسامبر ۲۰۲۶، یک نفر، سه شب، هتل دو ستاره به بالا، بودجه کل ۳۰ میلیون تومان. گزینه‌ها رو بررسی کن.» (1st try, 19:34) | First LLM request → HTTP 429, `tokens per day`. The UI showed the Persian rate-limit message with the wait time. |
| Same message (2nd try, 19:46) | LLM request 1 succeeded (2,306 prompt / 76 completion tokens, 1.3 s). It called `update_trip_goal` with only origin, return date and rooms. The UI showed the live step «✓ ثبت جزئیات سفر». Request 2 → 429: *Limit 200000, Used 199363, Requested 2742*. The error was shown as an alert, not as an answer. |
| Developer's own earlier session (19:28) | 3 successful LLM calls with tool calls. The model put «۱۹ آذر» into **returnDate** as well as departureDate. The goal ended up with return = departure while nights = 3, and the model's reply asked the user about this inconsistency. |

What this shows:

- The real adapter, tool calling, progress events and honest error display work.
- A single request costs about 2.3–3.1k prompt tokens. With 200k tokens a day, that allows roughly 60–70 requests, which is about 15–20 user messages (2–4 requests each). This free-tier limit is a real constraint on testing and daily use.
- **Not verified:** streamed answer text from the real model, result cards from a real LLM-driven search in the browser, and the LLM's handling of a Gregorian date range («۱۰ تا ۱۳ دسامبر ۲۰۲۶»).

## 4. Real MrBilit (via the monitoring worker)

`peyva:worker --once` checked goal #2 (Tehran→Kish, 19–22 Azar 1405 = 10–13 Dec 2026, 1 adult, 1 room, ≥2★, budget 30M):

- **Searches:** `mb_search_flights` THR→KIH 2026-12-10 ok (2.1 s), `mb_search_flights` KIH→THR 2026-12-13 ok (1.6 s), `mb_find_place` کیش ok (0.8 s) and `mb_search_hotels` kish ok (3.5 s). The hotel list was truncated by the provider (20 of 27), and this was disclosed in the result.
- **Result:** `MATCH_FOUND`, cheapest complete package 25,114,300 Toman. It was computed in code by the comparison engine. Next check was set to +6 h.
- **Notifications:** in-app row stored. The Telegram row went to `sent` after the Bot API confirmed it. This is the first real match alert delivered by Telegram (Phase 3 had only verified a test message).
- **Goal panel:** after the worker run, the panel showed «آخرین بررسی موفق: … گزینهٔ مطابق پیدا شد (۲۵٬۱۱۴٬۳۰۰ تومان)» from PostgreSQL.

## 5. Database and persistence (real browser, real PostgreSQL)

| Check | Result |
|---|---|
| Goal created and approved (CLI) is visible in the web goals panel | ✅ |
| Pause with the panel button → DB `paused` → resume → DB `active`, original next-check time kept | ✅ |
| `/budget 2 ۲۸ میلیون` in the web chat → goal back to `draft` with approval cleared; approval panel shown; «فعال کن» → DB `active` with budget 28,000,000; confirmation text built from the DB row | ✅ |
| `/budget 2 ۲۶ میلیون` on mobile → «فعال نکن» → DB `canceled`; goal removed from the panel; reply «پیگیری فعال نشد (پیش‌نویس #۲ لغو شد)» | ✅ |
| Page reload → transcript and goal status from PostgreSQL | ✅ |
| Server restart #1 (old conversation had no snapshot) → new conversation, logged `no_state`; goals unchanged | ✅ |
| Server restart #2 → `resumed: true, conversationId 3`; partial trip goal restored (origin تهران, return 2026-12-13); UI notice «این گفتگو پس از راه‌اندازی دوبارهٔ سرور … ادامه یافت» | ✅ |
| Server restart #3 → resumed again (8 messages; this snapshot predated fix 1, so the transcript fallback was used) | ✅ |
| Worker separately: claims only due active goals; canceled goal #2 not listed afterwards | ✅ (goal #1 was not yet due) |

## 6. Browser verification (built-in browser pane, Chromium)

| Area | Result |
|---|---|
| Persian RTL layout, Vazirmatn/Lalezar fonts, ticket styles | ✅ desktop 1280×720 and mobile 375×812 |
| Responsive: goals in a side panel (desktop) / collapsible section (mobile); no overlapping controls after fix 2 | ✅ |
| Input: typing, Enter to send, button disabled while busy | ✅ |
| Message scrolling to the newest message and the approval panel | ❌ → fixed (fix 2) → ✅ re-checked on mobile |
| Tool progress («✓ ثبت جزئیات سفر») from a real LLM tool call | ✅ |
| Streaming text from the real LLM | NOT VERIFIED (quota) |
| Result cards from real data in the browser | NOT VERIFIED live (worker computed the same package in code; cards are covered by API/UI tests with recorded real data) |
| Approval interaction (approve and reject) | ✅ |
| Error state (LLM 429) | ✅ shown as alert after fix 1b |
| Loading state | ✅ «پیوا در حال کار است» / running step marker seen during the real turn |
| Page reload | ✅ |
| Long responses | Partly: multi-line goal summaries and command outputs wrap correctly on mobile; long LLM answers NOT VERIFIED |
| Production build on 4317 | ✅ |
| Vite dev proxy on 5173 | ✅ GET `/api/state` 200; POST `/api/goals/99999/pause` reached the handler (404, not a 403 guard rejection); `POST /api/chat` streamed `text/event-stream` (`accepted → reply → state → done`) through the proxy. The proxy keeps `Host: 127.0.0.1:5173` and `Origin: http://127.0.0.1:5173`, both on the allow-list. |
| Host/Origin protection | ✅ automated tests and VM smoke test (foreign Host 403, foreign Origin 403, `0.0.0.0` bind refused). Not re-attacked from another origin on Omarchy. |

## 7. Critical issue: working memory after a server restart

**Finding.** Before the fix, a restart lost the agent's working state: trip goal, last comparison, pending approval and LLM context. The transcript survived, but the next message started from an empty goal, so the agent would ask again for things the screen showed it already knew. That is misleading.

**Can the session be reconstructed safely?** Yes, for what matters. The structured state is small and fully known in code, so it can be stored as a versioned snapshot. The LLM context needs only the text turns, because the current goal is put in the system prompt on every request and tool results are not needed. Search caches are deliberately not restored: a later search runs fresh.

**Fix.**
- `conversations.state` (jsonb) and `updated_at` were added in migration 0001. A versioned snapshot is saved after every message and approval. It contains the trip goal, the last comparison, the pending approval and the LLM text history.
- On start, the web server resumes only **the latest conversation** of the user, only if it was saved within `PEYVA_RESUME_HOURS` (default 24).
- A pending goal approval is kept only if that draft is unchanged in the database (status `draft` and the same hash).
- Restored comparison cards are marked as older than 15 minutes.
- An unreadable or unknown snapshot means a fresh session.
- «گفتگوی تازه» always starts a new conversation.
- Nothing is merged across conversations.

**Bug found live and fixed.** In the first version, the LLM context was rebuilt from the transcript, so a Groq rate-limit message came back as an *assistant* turn. The snapshot now stores the live session's own text history, which excludes error replies, approval texts and command outputs. Snapshots written before this fix fall back to the transcript.

**Tests:** `test/web-resume.test.ts` (5) covers these cases:
- resume with goal, context, cards and a valid pending approval, then approve after restart
- a pending approval dropped when the draft was canceled meanwhile
- too old, unreadable and reset are never resumed
- the window set to 0
- the context excludes failed-LLM replies

## 8. Bugs found and fixed

| # | Found in | Defect | Fix |
|---|---|---|---|
| 1 | Step 5 | Agent working memory lost on restart | Snapshot and resume (§7), commit 709d0d2 |
| 1a | live restart | Rate-limit error text restored into the LLM context as an assistant turn | Context from the snapshot's live history, e7b7e67 |
| 1b | live 429 | LLM failure rendered like a normal answer | Rendered as an alert, 709d0d2 |
| 2 | live mobile | Approval panel and newest reply hidden under the sticky composer; the user had to scroll to find the buttons | Scroll the document to its end on new messages and approvals (two iterations: e7b7e67, then this commit) |
| 3 | live desktop | Two goals with identical names in the panel, so the wrong one could be paused or canceled | Goal number shown in the panel, e7b7e67 |
| 4 | live | Latin commands inside Persian replies (`/pause 2`, `bun run peyva:worker`) rendered scrambled | Unicode directional isolates; user bubbles `dir=auto`, e7b7e67 |
| 5 | live | Route line «تهران ← → کیش» unreadable | «تهران به کیش و برگشت», e7b7e67 |

## 9. Tests

- **Automated, after all fixes:** `bun run test:all` gives 127 server tests, 6 UI tests and 35 spike tests, all passing. 0 failures. `bun run typecheck` (server, web, spike) is clean. `bun run web:build` succeeds.
- **Failures during this phase:** the real-LLM scenario (429 quota, external) and the scroll check on mobile (fixed and re-checked).

## 10. NOT VERIFIED / known issues

- **NOT VERIFIED:** a complete real-LLM conversation in the browser, including streamed text, real result cards, the LLM's handling of «۱۰ تا ۱۳ دسامبر ۲۰۲۶» and creating a monitoring draft through `start_monitoring` from natural language.
- **NOT VERIFIED:** Firefox, and a non-Chromium engine in general.
- **Known issue (behaviour, not fixed):** rejecting changed conditions (`/budget`, then «فعال نکن») cancels the goal instead of restoring the previous conditions. The reply says so explicitly, but it may surprise the user. Revisit in Phase 4B.
- **Known issue (cosmetic):** error replies restored after a reload are shown as plain text, not as alerts.
- **Known issue (by design):** one session per server process, so the 4317 and 5173 tabs share the same conversation (single-user mode).
- **Observed, not investigated:** the developer needed Ctrl+C twice to stop `peyva:web`. Shutdown waits for the MCP client to close.
- **Model quality:** the model split the first scenario request into a partial update and, in another session, assigned the departure date to the return date. Deterministic validation caught the inconsistency, but this costs extra turns and tokens under a tight quota.

## 11. Next action

Run the §3 scenario once tomorrow, when the Groq quota has reset, with the worker stopped so that tokens go only to the conversation:

1. Send the message.
2. Then send «اگه قیمت پایین اومد خبرم کن».
3. Approve in the panel.
4. Restart the server and send one follow-up message.

If it passes, Phase 4A becomes **GO**.
