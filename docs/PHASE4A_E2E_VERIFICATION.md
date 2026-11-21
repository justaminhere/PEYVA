# Phase 4A: end-to-end verification and stabilization

Runs: 2026-11-20 (evening, Tehran) and 2026-11-21 (morning, Tehran). Scope: verification and fixes only. No Phase 4B work.

## Decision: GO

On 2026-11-21 a complete conversation ran in a real browser, with real data end to end: real Groq LLM, real MrBilit MCP, real PostgreSQL and the React/Hono app. It covered:

- the trip request, with the goal extracted correctly (Gregorian date range), real searches, a deterministic comparison, a streamed Persian answer and result cards with provider and check time
- monitoring: draft, explicit approval in the UI, persisted as `active`
- a server restart, with the conversation resumed and continued by the real LLM
- the fixed «تغییر نده» behaviour

Every step listed in §11 passed. One serious live defect (a tool-call loop) was found during the run, fixed, regression-tested and re-run live (§3, §8).

Remaining issues are listed in §10. None of them blocks Phase 4B.

## 1. Environment

| | |
|---|---|
| Machine | developer's Omarchy Linux (server, PostgreSQL, worker, browser). Tests and builds also ran in the Linux VM of the Claude desktop app, whose network cannot reach Groq or MrBilit. |
| Runtime | Bun 1.4.5. Builds: Vite 8.3.8, Tailwind 4.3.5, React 19.3.1, Hono 4.13.19 |
| LLM | Groq OpenAI-compatible endpoint, model `qwen/qwen3.8-27b` (key present in `.env`; its value was never read) |
| Database | embedded PostgreSQL 18 (`bun run db:start`, port 54329). Migrations 0000 and 0001 were applied automatically by the server. |
| Travel | MrBilit MCP (`mrbilit-mcp` via uvx), read-only |
| Browser | the Claude desktop app's built-in browser pane (Chromium-based), driven by Claude: desktop 1280×720 and mobile emulation 375×812. Firefox and Playwright were not available to the agent. |
| Run 2 | same machine and stack; commits c32a7bf → b59c2b1 → final; worker stopped during the run so tokens went only to the conversation |

## 2. Commands executed

On Omarchy (by the developer):

```bash
bun install && bun run web:build && bun run peyva:web     # three times: initial, after fix 1, after fixes 2–6
bun run web:dev                                          # Vite dev server on 127.0.0.1:5173
bun run peyva:goals create --origin تهران --destination کیش --depart "۱۹ آذر ۱۴۰۵" --nights 3 --adults 1 --rooms 1 --stars 2 --budget "۳۰ میلیون"   # answered «بله»
bun run peyva:worker --once
```

Run 2 on Omarchy (by the developer): `bun run peyva:llm-check`, then `bun run peyva:web` restarted 3 times (new code; after fix 6; restart test). The VM build was served from the shared folder.

In the VM (by Claude):

```bash
git status; bun run typecheck; bun run test; bun run test:all; bun run web:build
bun x drizzle-kit generate --name conversation_state
```

In the browser (by Claude): the §3 message; the `/goals` and `/budget 2 …` commands; the approval buttons; pause, resume and cancel; reloads; `fetch` probes of `/api/*` on both ports.

## 3. Real LLM (Groq)

### 3a. Run 2 (2026-11-21): the scenario, end to end

**Quota before spending tokens.** `bun run peyva:llm-check` costs no tokens:
- It confirmed `GET /models` HTTP 200 with the model listed.
- It estimated the available daily budget from Groq's own last 429 message (*Limit 200000, Used 199363* at 18:46 UTC).
- Groq refills continuously at about 139 tokens per minute (its "try again in 15m9s" for a 2,105-token deficit matches exactly), so the estimate was ~20.8k at 21:12 UTC and full again by the morning.

**Actual calls and tokens** (from the session logs; `usage` as reported by Groq):

| Message | LLM requests | Prompt + completion tokens | Time | MCP calls | Result |
|---|---|---|---|---|---|
| Scenario message, attempt 1 (before fix b59c2b1) | 6 | 20,282 + 456 = **20,738** | 116 s | 0 | ❌ The model sent the same partial `update_trip_goal` 6 times: first `{origin, returnDate, rooms}`, then 5× `{destination, returnDate, rooms}`. It never added the departure date, travellers, nights, stars or budget. The turn hit the iteration limit and answered «نتوانستم…». Per-call latency grew to 30–37 s. |
| Scenario message, attempt 2 (after fix) | 3 | 8,616 + 272 = **8,888** | 15.7 s | 4 | ✅ See below |
| «اگه قیمت پایین اومد خبرم کن» | 2 | 5,904 + 63 = **5,967** | 26.1 s (one Groq call took 25.7 s) | 0 | ✅ `start_monitoring` → draft #3 |
| After restart: «اگه هتل سه ستاره به بالا باشه چی؟» | 2 | 5,873 + 136 = **6,009** | 6.8 s | 4 | ✅ See §7 |
| **Total run 2** | **13** | **41,602** | | **8** | |

**Attempt 2 in detail:**
- **What the model sent:** call 1 `{origin: تهران, returnDate: «۱۳ دسامبر ۲۰۲۶», rooms: 1}`. Call 2 `{destination: کیش, origin, returnDate, rooms: 1}`. The model still sends partial updates and invents `rooms`.
- **What the app did** (fix 6):
  - It recorded from the user's own words the departure date (first day of «۱۰ تا ۱۳ دسامبر ۲۰۲۶»), adults=1, nights=3, minimumHotelStars=2 and the budget «۳۰ میلیون تومان» with scope `total`.
  - It dropped the invented `rooms`. One room is derived from one traveller instead.
- **Goal after the turn:** departure 2026-12-10, return 2026-12-13, 3 nights, 1 adult, ≥2★, budget 30,000,000 total, no warnings.
- **Searches:** with the goal ready, the app searched by itself: `mb_search_flights` THR→KIH 2026-12-10 (2.4 s, 5 results), KIH→THR 2026-12-13 (0.9 s, 6), `mb_find_place` کیش (0.9 s) and `mb_search_hotels` kish (3.6 s, 20 of 27, disclosed as truncated).
- **Cards (deterministic):**
  - Option 1: ZV 4030 (10,194,100) + ZV 4031 (10,794,100) + هتل پانیذ 2★ (3,726,000) = **24,714,200 Toman**, «در بودجه». The sum was checked by hand.
  - Options 2 and 3 are سان رایز (25,203,200) and تعطیلات (25,437,200).
  - Each card shows «منبع: mrbilit · بررسی‌شده ساعت ۱۱:۰۶ تهران» and the "listed, not booked" disclaimer.
  - The price changed against yesterday's 25,114,300: the outbound fare dropped from 10,594,200 to 10,194,100. The cards show today's real data.
- **Streaming:** recorded in the page every 40 ms, the final text grew 69 → 115 → 162 → 213 → 271 characters over about 200 ms, then the cards appeared and the turn ended.
- **The model's answer:**
  - It recommended option 1 by number and repeated no prices except the user's own budget, so the price guard raised no warning.
  - It stated that results are not a booking.
  - It said the table is "above". That was untrue in the UI until fix 7.

**Why one message costs several requests.**
- Every request carries about 2k fixed tokens: system rules and goal state (~1k) and tool schemas (~1k, of which `update_trip_goal` is ~640).
- The current turn's tool result is small, about 500 tokens with the comparison.
- The minimum is 2 requests: an update that also searches and compares, then the answer.
- The avoidable extra requests were the model's partial and repeated updates. With fix 6, the scenario took 3 requests instead of 6 or more, and repeats are refused before execution.
- Prompt size was not cut further, so no rule or validation was removed.

### 3b. Run 1 (2026-11-20)

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
| Streaming text from the real LLM | ✅ run 2 (text grew in chunks; recorded in the DOM every 40 ms) |
| Result cards from real data in the browser | ✅ run 2: 3 tickets, live MrBilit prices, provider and check time, truncation note, disclaimer; shown above the answer after fix 7 |
| Approval interaction (approve and reject) | ✅ |
| Error state (LLM 429) | ✅ shown as alert after fix 1b |
| Loading state | ✅ «پیوا در حال کار است» / running step marker seen during the real turn |
| Page reload | ✅ |
| Long responses | ✅ the multi-paragraph answers in run 2, goal summaries and command outputs wrap correctly. Answers far longer than these were not produced |
| Production build on 4317 | ✅ |
| Vite dev proxy on 5173 | ✅ GET `/api/state` 200; POST `/api/goals/99999/pause` reached the handler (404, not a 403 guard rejection); `POST /api/chat` streamed `text/event-stream` (`accepted → reply → state → done`) through the proxy. The proxy keeps `Host: 127.0.0.1:5173` and `Origin: http://127.0.0.1:5173`, both on the allow-list. |
| Host/Origin protection | ✅ automated tests and VM smoke test (foreign Host 403, foreign Origin 403, `0.0.0.0` bind refused). Not re-attacked from another origin on Omarchy. |

## 7. Critical issue: working memory after a server restart

**Live, run 2 (after the fix).**
- **After the restart:** the server printed and logged `resumed: true, conversationId 5, messages 4`, the four live text turns without the approval texts. `/api/state` returned:
  - the full goal (Tehran→Kish, 2026-12-10..13, 3 nights, 1 adult, ≥2★, 30M total)
  - the 3 cards, with their 11:06 check time and correctly *not* marked stale (4 minutes old)
  - the transcript
  - goals #3 and #1 `active`, and the «ادامه یافت» notice
- **The follow-up** «اگه هتل سه ستاره به بالا باشه چی؟»:
  - The real LLM sent only `{minimumHotelStars: 3}`. Everything else came from the restored goal.
  - The app searched again (caches are deliberately not restored) and compared. The cheapest option became سان رایز 3★, 25,203,200.
  - It took 2 LLM requests and 6.8 s.

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
| 6 | **run 2, live** | **Tool-call loop:** the real model re-sent the same partial `update_trip_goal` 6 times; no answer, 20.7k tokens | The app records details stated unambiguously in the user's message that the LLM left out (stay date range, traveller count without children, nights, stars, budget words and scope) and reports them as `recordedByAppFromUserWords`. Invented values are still dropped and ambiguous ones still go back to the LLM. An identical repeated tool call in one turn is refused. Replay test of the exact live calls. Commit b59c2b1 |
| 6a | run 2 review | Dates: departure vs return | A day range in the user's words («۱۰ تا ۱۳ دسامبر ۲۰۲۶», «۱۹ آذر تا ۲۲ آذر») is checked against what the LLM recorded, and swapped or one-sided ranges are refused. A single date is never stored as the return date while no departure is known (live bug from run 1). Not a stay: «بین …», flexible wording, windows, or a range that disagrees with the stated nights. Commit c32a7bf |
| 7 | run 2, live | The answer says «جدول … بالای صفحه» but the cards were rendered *below* the text | Cards are rendered before the agent's text, as in the terminal. Verified live after the restart |
| 8 | known issue from run 1 | Rejecting changed conditions canceled the whole goal | A change to an active/paused goal is stored as a *proposal* (`proposed_constraints/proposed_hash`, migration 0002); the approved conditions keep running. «تغییر بده» applies it (hash-checked). «تغییر نده» drops only the proposal. Verified live on goal #3: status, approval time, schedule and budget were unchanged. Commit c32a7bf |

## 9. Tests

- **Automated, after all fixes (final):** `bun run test:all` gives 135 server tests, 7 UI tests and 35 spike tests, all passing. 0 failures. `bun run typecheck` (server, web, spike) is clean. `bun run web:build` succeeds.
- **New tests in run 2:**
  - `test/date-range.test.ts` (6): ranges in both calendars, swapped/one-sided/single-date cases, the full scenario update, a replay of the exact live loop, and no app fill for ambiguous input
  - change proposals in `memory-goals` (2), `phase3-chat`, `web-api` (1) and the UI (1)
  - existing tests adjusted to the new "app records stated details" behaviour
- **Failures during this phase:** the real-LLM scenario (429 quota, external) and the scroll check on mobile (fixed and re-checked).

## 10. NOT VERIFIED / known issues

- **Verified in run 2** (no longer open): the complete real-LLM conversation, streamed text, real cards, the Gregorian range, `start_monitoring` from natural language, and recovery after a restart.
- **NOT VERIFIED:** Firefox, and a non-Chromium engine in general.
- **Groq latency spikes:** single requests took 25–37 s, against 0.4–1.2 s normally, on the free tier. The UI shows progress meanwhile. No timeout was hit (45 s, 1 retry).
- **Model quality:** `qwen/qwen3.8-27b` still sends partial updates and invents `rooms`. The app now compensates deterministically. A model with better tool-calling would save tokens.
- **Monitoring semantics:** «اگه قیمت پایین اومد» becomes a goal with the trip's budget cap. The first alert comes as soon as a check finds an option within budget, including today's price, and later alerts need a ≥5% drop or a flight change. There is no goal type for "below today's price".
- **Not checked live in run 2:** the worker check of goal #3. The worker and Telegram path were verified live in run 1 on goal #2.
- **Known issue (cosmetic):** error replies restored after a reload are shown as plain text, not as alerts.
- **Known issue (by design):** one session per server process, so the 4317 and 5173 tabs share the same conversation (single-user mode).
- **Observed, not investigated:** the developer needed Ctrl+C twice to stop `peyva:web`. Shutdown waits for the MCP client to close.
- **Model quality:** the model split the first scenario request into a partial update and, in another session, assigned the departure date to the return date. Deterministic validation caught the inconsistency, but this costs extra turns and tokens under a tight quota.

## 11. Run 2 checklist (all executed in the real browser)

| Requirement | Evidence | Result |
|---|---|---|
| Quota checked before spending | `peyva:llm-check` (0 tokens) + bucket estimate | ✅ |
| Real Groq calls | 13 requests, usage logged | ✅ |
| Correct goal extraction (Gregorian range, stars, budget scope) | goal in log and `/api/state` | ✅ after fix 6 |
| Real MrBilit searches | 8 MCP calls, all `ok` | ✅ |
| Deterministic comparison, correct price | 24,714,200 = 10,194,100 + 10,794,100 + 3,726,000 | ✅ |
| Streamed Persian response | DOM growth recorded during the stream | ✅ |
| Cards with provider, check time, freshness and disclaimer | page text | ✅ |
| Monitoring draft → explicit approval → DB `active` | `/api/goals/3` | ✅ |
| Restart → conversation recovery → real follow-up | resume log, `/api/state`, follow-up turn | ✅ |
| Rejecting a change keeps the approved goal | before/after comparison of `/api/goals/3` | ✅ |
| Regression tests, typecheck, build | 135 + 7 + 35 pass | ✅ |

## 12. Next action (from run 1, done in run 2)

Run the §3 scenario once tomorrow, when the Groq quota has reset, with the worker stopped so that tokens go only to the conversation:

1. Send the message.
2. Then send «اگه قیمت پایین اومد خبرم کن».
3. Approve in the panel.
4. Restart the server and send one follow-up message.

Done on 2026-11-21 (§3a, §7, §11). For Phase 4B, start by reading the run-2 session logs: the moments where the conversation was clumsy are the input for the next UX milestone.
