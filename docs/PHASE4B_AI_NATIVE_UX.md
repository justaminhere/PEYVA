# Phase 4B: AI-native UX discovery and implementation

Status: implemented. Automated tests pass, and a real-browser walkthrough was done on 2026-11-21. Scope: interaction design on top of the Phase 4A app. There are no new domains, no booking and no public deployment.

## 1. UX audit (before changes)

**Sources:**
- 35 real LLM turns and 5 command/approval turns from `output/sessions/*.jsonl`. These are the developer's own sessions from 2026-11-20 and 21, in the terminal and the web app.
- The Phase 4A E2E report.
- The code.
- The live page in the Claude desktop app's browser pane.

**This is not user research.** All sessions are the developer's own. Findings marked *observed* come from those logs or the live page; findings marked *hypothesis* are design judgement.

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | High | **Slow slot filling by chat.** A trip took 4–6 messages before any result, each answered with a single question («از کجا؟» → «چه تاریخی؟» → «چند نفر؟»). Every turn costs 2+ LLM requests (≈5k tokens). | Observed: sessions `chat-…T15-12`, `chat-…T16-05`, `web-…T18-27` |
| 2 | High | **The goal is invisible.** What PEYVA understood was never visible in the web UI, so misreadings were only discovered through later questions. Examples: «سه شبه» read as «سه‌شنبه» ("کدوم سه‌شنبه؟"), and a single date stored as the return date. | Observed: session `chat-…T15-12`; E2E run 1 |
| 3 | High | **No way forward when the LLM fails.** 8 of 35 LLM turns failed: 5 rate limits, 1 network error, 1 bad request, 1 iteration limit. While the model is down, the user cannot change or re-run anything. | Observed: log counts |
| 4 | Medium | **An extra turn for the assumed year.** Confirming «۱۴۰۵ درست است؟» cost a whole chat turn. | Observed: session `chat-…T15-12` |
| 5 | Medium | **Repetitive results.** Three tickets repeated identical flights, there was no reason why an option fits, and freshness was a footnote. | Observed: live page text, E2E run 2 |
| 6 | Medium | **Monitoring is hard to follow.** Match alerts (in-app and Telegram) existed in PostgreSQL but were invisible in the web app. The approval reply pointed to CLI commands («/pause 3») inside a web UI. | Observed: E2E run 1 and run 2 |
| 7 | Medium | **Approving a change showed only a full summary**, not what changes. | Observed: Phase 4A approval panel |
| 8 | Low | **Progress was noisy:** duplicated «ثبت جزئیات سفر» lines, and Latin codes and ISO dates («THR→KIH 2026-12-10») in a Persian UI. | Observed: live page |
| 9 | Low | **Cancel had no confirmation** (one click ended a monitoring goal). | Observed: code |
| 10 | Low | **Long turns:** the median turn was 11.3 s and the maximum 151 s (provider latency), so progress feedback matters. | Observed: logs |

## 2. Interaction language

The language is small and reusable. Each element maps to existing server state.

- **Conversation:** user bubbles; the agent's streamed text; quiet notes for actions done with controls («تغییر دادی: …», «(دکمهٔ تأیید)»); errors as alerts.
- **Agent progress:** live steps while working. When the turn is done they collapse into one line: «✓ ثبت جزئیات سفر، مقایسهٔ گزینه‌ها · ۳ جست‌وجوی واقعی». Repeated steps are merged, and search labels are Persian with Jalali dates.
- **Goal brief («آنچه فهمیدم»):** the session's understood goal as chips above the composer.
  - Missing details are marked, an assumed year can be confirmed in one click, and conflicts appear in Persian.
  - It shows «زیر نظر پیوا · #N» when an approved goal watches exactly this trip.
  - It offers the action that fits the state: «جست‌وجو با همین شرایط» or «جست‌وجوی دوباره با شرایط تازه».
- **Results:** for each candidate date there is a freshness pill, the shared flights shown once, hotel options with the total trip price, and why each option fits (budget margin, stars). With several dates, a tab overview shows the cheapest price per date, with the engine's best date selected first.
- **Approval:** one panel for anything that needs a yes. A *change* is shown as a before/after table. Rejection is always safe.
- **Activities:** a goal card showing status, next check, last success and last failure separately, the latest alert with its stored Telegram status and unread state, «توقف / ادامه / تغییر شرایط / لغو پیگیری» (cancel asks again in place), and the conditions on demand. The card appears next to the approval reply and in «کارهای در جریان پیوا» (a side panel on desktop; a header button on mobile).

## 3. Candidates evaluated

| Candidate | Problem / evidence | Why chat alone is not enough | Decision |
|---|---|---|---|
| **Inline goal editing** | Findings 1–4 | Filling or fixing one field costs a full LLM round trip and does not work when the LLM is down; the user cannot see what was understood | **Built** (most evidence) |
| **Compact comparison and multi-date overview** | Finding 5; flexible ranges give 3 dates × 3 options | Prose cannot compare 9 packages; the price guard forbids the LLM from repeating prices anyway | **Built**: shared flights, match reasons, freshness, date tabs |
| **Contextual monitoring and in-app alerts** | Findings 6, 7, 9 | Alerts and check results are state that changes without a conversation turn | **Built**: goal card in context, alerts, proposal diff, safe cancel |
| Better visualization of the agent's work | Findings 8, 10 | Partly | Folded in as polish (merged steps, Persian labels, collapsed summary). No new component |
| Clearer approval and cancellation | Findings 7, 9 | Yes | Folded into the three built items (diff table, in-place cancel confirmation) |

**Postponed or rejected:**
- Notification centre page: alerts are shown per goal. A separate list is not needed until there are many goals.
- A stop button for a running turn: useful (finding 10), but it needs cancellation through the agent loop and MCP calls, so it belongs in a later phase.
- Date-picker calendar: free text in both calendars already works and is validated by the server.
- Preference management UI: no usage in the logs.
- A travel dashboard: out of scope by design.

## 4. Components added or changed

**Web (`web/src`):**
- `ui/Brief.tsx`: brief, chips and field editor.
- `ui/Results.tsx`: candidate tabs, shared-flight block, hotel rows, full tickets.
- `ui/Activities.tsx`: `GoalCard`, `ProposeForm`, `Activities`.
- `ui/Approval.tsx`: approval panel with a diff table.
- `App.tsx`: wiring, merged steps, notes, the live goal card next to the approval reply, 60 s activity refresh while the page is visible, polite live region.
- `api.ts`: typed client with `ApiError`.

**Server, with no business logic in the browser:**
- `src/web/trip.ts`:
  - `tripView` builds the brief from `analyze()`, Persian conflicts and the monitored-goal match by constraints hash.
  - `applyTripEdit` validates an edit and applies it with `applyPatch`. City, date (in the past or unreadable), amount and number ranges are validated; dates keep their length, and a new departure drops stale year assumptions.
- `src/web/views.ts`: `diffSummaries` (works for any executor's `describeFa`), async `pendingView` with the diff, `lastAlert` and `editable` in `GoalView`.
- `src/render/cards.ts`: `sharedFlights`, `matchFa`, `statusFa`, `fresh/checkedFa`, `cheapestTotalFa`, `bestIndex` (from `bestOverall`).
- `src/notify/service.ts`: `latestForGoal`, `unreadCount`.
- `src/web/app.ts`, new endpoints:
  - `POST /api/trip`: one validated edit of the session goal.
  - `POST /api/compare`: runs `compare_trip_options` through the same `ToolRunner`, with no LLM.
  - `POST /api/goals/:id/propose`: `GoalService.updateConstraints` creates a proposal and the approval panel shows its diff.
  - `POST /api/notifications/read`.
  - `GET /api/activity`.
  - Every response carries one `snapshot` (pending, trip, goals, unread count).
- `src/agent/*`:
  - Web replies no longer mention CLI commands (`Session.surface`).
  - `start_monitoring` refuses a second goal for identical conditions.
  - Search progress labels are Persian.

## 5. How the interactions use backend state

- **Brief:** shows `analyze(session.goal)`. An edit goes through `applyPatch` (the same path as the LLM's `update_trip_goal`). The edit is recorded as a user note in the transcript and in the LLM context, so the model knows what the user changed. The session snapshot is saved, so it survives a restart.
- **Results:** the server builds the view model from `ComparisonSnapshot` (real provider results). The browser only lays it out. «outdated» compares the search-relevant fields of the goal the comparison was made for with the current goal.
- **Monitoring:** a proposal for an active goal stores `proposed_constraints` and keeps the approved conditions running (Phase 4A fix). The approve and reject buttons use the single `decidePending` path. The goal card reads `goals`, `goal_checks` and `notifications` from PostgreSQL. Nothing about progress, alerts or times is produced in the browser.

## 6. Accessibility and RTL

- **Language and direction:** `lang="fa" dir="rtl"`. User bubbles use `dir="auto"`, flight numbers `<bdi dir="ltr">`, and Latin commands in replies have Unicode isolates. Numbers, dates and currency are Persian (Jalali dates, «٬» grouping).
- **Accessible names:**
  - Every chip is a button named «<field>: <value>؛ ویرایش».
  - Editors have real `<label>`s. Invalid input is marked `aria-invalid` with the error in `role="alert"`.
  - The stars field is a `radiogroup`.
  - Candidate dates use `tablist/tab/tabpanel` with `aria-selected`.
  - The approval panel is a labelled region, and the change table is a real `<table>`.
- **Keyboard:** Enter saves, Escape cancels, and focus returns to the edited chip (fixed during the walkthrough: before, focus was lost because the chip was still disabled). Focus rings are visible (`:focus-visible`, saffron).
- **Announcements:** state changes are announced in a polite live region («بودجه: … ← …», goal status after pause/resume).
- **Touch targets:** at least 36–44 px (`min-h-9…11`). The walkthrough found no button shorter than 36 px on mobile.
- **Visibility:** nothing is hidden behind the sticky composer. The page scrolls to the newest message and to a new approval panel, and the panel's buttons were checked to be above the composer.
- **Motion:** `prefers-reduced-motion` turns off the caret and the panel's entrance animation.
- **Contrast:** body ink #14233b and secondary #4b5b72 on #f2f6f5/#fff are above 4.5:1. Status colours are paired with words («در بودجه», «فعال»), never colour alone.

## 7. Real-browser walkthrough (2026-11-21)

**Setup:**
- Browser: the Claude desktop app's built-in browser pane (Chromium) on the developer's Omarchy machine, driven by Claude. Real `peyva:web`, real PostgreSQL, real Groq LLM, real MrBilit.
- Viewports: 1280×720, 375×812 (mobile emulation), 1600×900.
- Screenshots from this pane are cropped by its device pixel ratio of 1.22, so layout was also checked through the DOM (sizes, overflow, focus, positions).

| Scenario | What happened | Result |
|---|---|---|
| A. First conversation | «یه سفر سه شبه به کیش می‌خوام» → **1 real LLM turn**; the model asked only «از کجا می‌خواید برید؟». The brief showed «مقصد کیش», «اقامت ۳ شب» and missing «+ مبدأ؟ / + تاریخ؟ / + مسافر؟». Origin, date, travellers and budget were then filled **in the brief with real typing and Enter, with no LLM call**. Each edit left a note («تغییر دادی: …»). The brief recognized that this exact trip is already watched («زیر نظر پیوا · #۱»). | ✅ |
| B. Real results | «جست‌وجو با همین شرایط» → 4 real MrBilit calls (2.5 + 1.7 + 0.6 + 3.9 s) → shared flights ZV 4030 / ZV 4031 shown once, 3 hotel options with the total trip price (۲۴٬۷۱۴٬۲۰۰ / ۲۵٬۲۰۳٬۲۰۰ / ۲۵٬۴۳۷٬۲۰۰), «در بودجه؛ ۵٬۲۸۵٬۸۰۰ تومان کمتر از سقف» (= 30,000,000 − 24,714,200), «قیمت تازه · ساعت ۱۱:۵۵», provider, truncation note and disclaimer. The button showed «در حال جست‌وجو در MrBilit…» meanwhile. | ✅ |
| C. Monitoring | Stars set to ≥2 in the brief: «زیر نظر پیوا · #۳» appeared (an existing goal with these exact conditions). Budget changed to 28M: no longer watched. «اگه قیمت پایین اومد خبرم کن» → **1 real LLM turn** → a draft with the *edited* conditions → «فعال کن» → goal #4 `active` in PostgreSQL, the live goal card next to the confirmation and «زیر نظر پیوا · #۴» in the brief. | ✅ |
| D. Edit and reject | Goal #4 card → «تغییر شرایط» → budget 25M → «پیشنهاد تغییر» → the panel showed one row: «سقف جمع … ۲۸٬۰۰۰٬۰۰۰ → ۲۵٬۰۰۰٬۰۰۰». The goal stayed `active` with «تغییر شرایط منتظر تأیید است…». «تغییر نده» → status, approval time, next check and conditions were identical to before (compared through the API). | ✅ |
| E. Mobile and reload | Reload restored the transcript, notes, cards, brief and goals. Mobile showed **a defect**: the brief wrapped to 5 lines and the sticky area took 405 of 812 px. Fixed (one swipeable row); after the fix it was 239 px, with no horizontal overflow and no button under 36 px. The mobile «پیگیری‌ها (۳)» button opened the 3 goals. 1600×900: side panel 320 px, conversation 736 px, no overflow. | ✅ after fix |
| Restart | `peyva:web` restarted with the final server code → `resumed: true, conversationId 6`. The brief, notes (6), last cards, «outdated» state and «زیر نظر پیوا · #۴» all came back. The fixes were live: a brief edit to 27M gave `assumedUnit: false` and the trip was no longer watched; back to 28M and it was «#۴» again. | ✅ |

**Defects found in the walkthrough and fixed:**
- mobile brief height
- focus lost after saving an edit (re-checked live after the fix: focus returns to «اقامت: ۳ شب؛ ویرایش»)
- a brief budget without a unit was treated as an assumed unit
- the text «دوباره» on a first search
- saving an unchanged value added a note («۳ شب ← ۳ شب»)
- a duplicate monitoring goal for identical conditions was possible

The duplicate goal was found by reasoning during scenario C; it was not observed live, and it is covered by a test only.

**Real versus mocked:**
- *Real:* everything in the table above. That is 2 Groq turns in this walkthrough; earlier Phase 4A runs are in the E2E report.
- *Mocked, in automated tests only:* the LLM (TEST-ONLY scripted and streaming fakes) and the provider (recorded real MrBilit responses). The product contains no mock path.

## 8. Automated tests

- `bun run test`: 147 server tests (including 12 new in `test/web-ux.test.ts`) and 12 UI tests (5 new), all passing. `bun run test:all` adds the 35 spike tests. `bun run typecheck` is clean and `bun run web:build` succeeds.
- **New server tests:**
  - the brief view (understood and missing fields)
  - filling gaps without LLM calls
  - preserving unrelated fields
  - rejecting invalid city, date, past date, amount and range
  - nights moving the return date
  - clearing stars
  - one-click assumption confirmation
  - re-checking without the LLM (with real recorded data)
  - comparison view model: shared flights, budget margin, freshness turning stale after 16 min
  - 3-date overview with the best date
  - monitored-trip detection
  - proposal diff, reject keeps everything, approve applies, the proposal replaces itself
  - latest alert with stored Telegram status and unread state
  - duplicate monitoring refused
  - budget unit
  - an unchanged value records nothing
  - `diffSummaries`
- **New UI tests (happy-dom, against the real server in-process):**
  - brief chips and accessible names
  - invalid input explained (`role=alert`, `aria-invalid`), with nothing changed
  - Escape returns focus
  - edit → «outdated» → one-click re-check with no LLM and no extra provider call (cache)
  - change from the goal card → before/after table → «تغییر نده»
  - cancel requires the in-place confirmation
  - multi-date tabs (keyboard-operable buttons, `aria-selected`)

## 9. Product quality review

| Area | Assessment (evidence) | Remaining weakness |
|---|---|---|
| Clarity | The understood goal is always visible; the result shows total, margin and freshness; activities show what is checked and what happened | Interim streamed text is replaced by the final answer, so it can jump |
| Ease | Filling 4 missing details took 4 edits, with no LLM and no waiting; it previously took about 4 chat turns | Free-text date entry has no calendar picker |
| Hierarchy | Conversation first; brief and activities are secondary; results lead the answer they belong to | On desktop the brief can wrap to 2 lines |
| Continuity | Edits and approvals are written into the transcript and the LLM context; restart recovery keeps it all | The LLM context gets edit notes as text only |
| Control | Every change is explicit; changes to approved goals are proposals; cancel is confirmed; nothing searches by itself after an edit | No way to stop a running turn |
| Accessibility | See §6 | Not tested with a real screen reader |
| Responsiveness | 375 / 1280 / 1600 checked; the mobile brief was fixed | Not tested on a physical phone or with an on-screen keyboard |
| Trust | All numbers come from engine or DB state; freshness, provider and disclaimer are shown; no fabricated alerts or progress | The model may still phrase things loosely (for example «✅» in a sentence about a pending approval) |
| Consistency | One approval panel, one card for goals everywhere, one snapshot per response | — |
| Extensibility | The brief and diff are built from generic pieces (`describeFa` lines, field descriptors); the goal card is executor-agnostic | The trip brief fields are travel-specific by design; another domain needs its own `tripView` equivalent |

## 10. Remaining usability issues

- No stop button for a long or slow turn.
- The live text of an iteration that ends in tool calls disappears when the tools start.
- Desktop brief wraps; a "collapsed" brief might be better once more fields exist.
- Real users (not the developer) have not used it.

## 11. Recommendations for user testing

Run 5–6 short sessions with people who book domestic trips. Use think-aloud, on their own phone where possible. Tasks:

1. "Plan a 3-night Kish trip under a budget." Measure: messages and edits until the first result; whether they notice and use the brief.
2. "Change the budget and see what changes." Measure: do they edit in the brief or by chat? Do they understand «outdated» and the re-check button?
3. "Ask PEYVA to watch the price, then change your mind about the budget." Measure: do they understand that rejecting keeps the old monitoring?
4. "A day later: what has PEYVA found?" (with a seeded alert). Measure: do they find the alert and the Telegram status?
5. Flexible dates ("sometime in early Dey"). Measure: do the date tabs help them choose?

Record where they hesitate or retype; those moments, not opinions, should drive Phase 5 decisions.
