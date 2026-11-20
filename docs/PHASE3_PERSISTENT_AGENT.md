# Phase 3: persistent memory, goals and monitoring

Status: implemented and tested offline against a real PostgreSQL 18 and recorded MrBilit data. The live provider check from the development VM classified correctly as `PROVIDER_ERROR` because that VM's network blocks the provider. **Live on Omarchy (2026-11-20): `worker --once` against MrBilit returned `MATCH_FOUND` at 25,114,300 Toman after 3 searches. It stored an in-app alert and set the next check +6 h. Live Telegram delivery: NOT VERIFIED.**

## 1. Scope and mode

- PEYVA is an educational, single-user agent. **Single-user educational mode:** there is no login. Every row has a `user_id`, set by `PEYVA_USER_ID` (default `local`). Every query is scoped to it. There is no HTTP API, and nothing listens on a public port. Do not deploy publicly or commercially.
- PEYVA is read-only toward providers. It does no booking or payment and holds no seats. Results mean "listed by the provider at check time".
- The phase was started by verifying Phase 2A/2B. The full suite (68 agent-core + 35 spike tests) passed before any Phase 3 code was written.

## 2. Architecture

```
chat (peyva:chat) ─┐                          ┌─ worker (peyva:worker, separate process)
goals CLI ─────────┤── GoalService ── PostgreSQL ──┤   claim (SKIP LOCKED + lease) → executor → goal_checks
                   │   PreferenceStore             │   → schedule → NotificationService → outbox → Telegram
                   │   ConversationStore           └─ ExecutorRegistry { travel_price → TravelPriceExecutor }
                   └── handleMessage: approval → command → LLM turn
```

- `src/db`: schema, client and embedded server.
- `src/memory`: preferences and conversations.
- `src/goals`: contract, service and travel executor.
- `src/worker`: the worker.
- `src/notify`: notification service and Telegram.
- `src/agent/{confirm,handle}.ts`: approvals and message routing.
- `src/cli/{goals,worker,commands,runtime,db}.ts`: the CLIs.

## 3. Data model and migrations

The schema is Drizzle (`src/db/schema.ts`). Migrations are in `drizzle/`, generated with `bun run db:generate`, and are applied automatically and idempotently by every CLI. You can also apply them with `bun run db:migrate`.

| table | purpose |
|---|---|
| `users` | the single local user |
| `conversations`, `messages` | chat history (user/assistant text only) |
| `preferences` | confirmed preferences: `key`, `value` jsonb, `confirmed_at` (NOT NULL), `source_message_id` |
| `goals` | `type`, `structured_constraints`, `constraints_hash`, `approved_constraints_hash`, `status`, `approved_at`, `next_check_at`, `last_checked_at`, `consecutive_failures`, lease columns `claimed_by` / `claim_expires_at`, `expires_at` |
| `goal_checks` | every execution: `status`, `provider`, `checked_at`, `result_summary` (minimal), `error_reason`, `worker_id`, `duration_ms` |
| `notifications` | in-app records and Telegram outbox: `channel`, `delivery_status`, `deduplication_key` UNIQUE, `attempts`, `next_attempt_at`, `last_error`, `delivered_at` |
| `telegram_links`, `telegram_link_codes`, `app_state` | verified chat link, hashed one-time codes, the getUpdates offset |

The database enforces the approval rule. A check constraint rejects `status = 'active'` unless `approved_constraints_hash = constraints_hash` and `approved_at` is set. A bug in application code therefore cannot activate an unapproved goal.

Secrets (API keys, bot token) are never stored in the database. The goal records contain only trip conditions.

## 4. Time and dates

- All timestamps are `timestamptz`. They are stored in UTC, and the connection uses `TimeZone=UTC`.
- For display, timestamps are interpreted in `Asia/Tehran`. They are shown as Jalali dates, for example "۲۹ آبان ۱۴۰۵، ساعت ۱۹:۲۲".
- Trip dates are ISO calendar dates produced by the Phase 2 deterministic Jalali/Gregorian code. That code rejects nonexistent days.
- A goal expires at the end of its last possible departure day in Tehran (20:30 UTC).

## 5. Personal memory (preferences)

- **Whitelist only:**
  - `home_city` (must be a known city)
  - `preferred_airlines` (≤5)
  - `min_hotel_stars` (1–5)
  - `travel_style` (economy|comfort|luxury)
  - `budget_preference`

  Anything else is refused by the tool schema and again by the store. This covers health, religion, identity, finances and any other sensitive inference.
- **Flow:** the LLM may only call `propose_preference`. The app asks the user. Only an explicit yes, detected by code, calls `PreferenceStore.confirm`, which is the only write path and records the source message id. A no discards the proposal. Any other reply leaves it pending and goes to the LLM.
- **View, edit and delete:** `/prefs`, `/pref set <key> <value>`, `/pref delete <key>`. These also work in the goals CLI.
- Confirmed preferences go into the system prompt as data. They are used for suggestions and never applied silently to the goal.

## 6. Goal engine

- **Contract:** `GoalExecutor<C> { type, schema (zod), nameFa, describeFa, expiresAt, run(c, {now}) → ExecutionResult }`. Executors are added through an `ExecutorRegistry`, and only `travel_price` is registered. Future executors (bills, mobile plans, …) implement the same contract.
- **Lifecycle:** `draft → (approve with the shown hash) → active ⇄ paused`; `draft|active|paused → canceled`; `active|paused → expired`.
  - Any change to the conditions recomputes the hash. If the hash changed, the goal returns to `draft`, approval is cleared and checks stop until the user approves again. `/budget` uses this path.
  - Approving with a stale hash fails with `stale_approval`.
- **LLM honesty:** the LLM tool `start_monitoring` only creates a draft. The app shows the conditions and resolves yes or no in code. Every confirmation message is built from the row the database returned, never from LLM text.
  - A guard flags LLM text that claims monitoring was activated.
  - Without a database, the monitoring and memory tools are not offered, and the honest notice is shown.

## 7. Background worker

`bun run peyva:worker` runs as its own process. `--once` runs a single pass.

- **Atomic claiming:** `UPDATE … WHERE id IN (SELECT … status='active' AND next_check_at <= now AND lease free … FOR UPDATE SKIP LOCKED) RETURNING`.
  - Two workers never get the same goal. This was tested with two connections.
  - A crashed worker's lease (10 min) expires, and another worker then takes over (tested).
- **Execution:**
  - Each run is wrapped in a timeout (5 min, which must be shorter than the lease). A hang becomes `PROVIDER_ERROR: timeout`.
  - Goals are processed with bounded concurrency (default 1) and a 2 s gap between goals.
  - At most 9 provider searches run per check, and a check stops at the first network, rate-limit or anti-bot error.
- **After the run:**
  - Each check is persisted as a `goal_check` row.
  - Scheduling is updated only while this worker still holds the lease.
  - A pause or cancel made by the user during the run is kept, and no alert is queued for a goal that is no longer active.
- **Schedule:**
  - The interval is ≥ 6 h. A shorter one is refused unless `PEYVA_DEV_ALLOW_SHORT_INTERVAL=1` is set, for simulation only.
  - After a provider error, retries back off 15 → 30 → 60 min, then fall back to the normal interval. Failures never cause a tight loop.
  - Success resets `consecutive_failures`.
- Draft, paused, canceled and expired goals are never selected. Due goals whose trip date has passed are expired first.

## 8. Travel price executor

The executor is deterministic and reuses Phase 2 code: `analyze` plan (≤3 candidate dates per check window), the cached search, `compareCandidate`, and untrusted-text cleaning. Each check is classified as one of:

- `MATCH_FOUND`: the cheapest complete option (outbound + return + hotel) whose total is within the budget. Its match key is `departure|outboundId|returnId|hotelId`.
- `NO_MATCH`: complete data, but nothing fits the budget or hotel stars.
- `INCOMPLETE_DATA`: the provider answered, but a leg or the hotel list was empty.
- `PROVIDER_ERROR`: network or geo block, rate limit, anti-bot, schema error or timeout. **This is never reported as "no match", and it never produces a user alert.**

If several candidate dates give different results, the precedence is MATCH > PROVIDER_ERROR > NO_MATCH > INCOMPLETE_DATA. One provider failure therefore prevents the check from claiming "nothing available".

## 9. Notifications and Telegram

- **When an alert is sent:**
  - An alert is sent only for `MATCH_FOUND`, never for errors or empty data.
  - An in-app row is always written. A Telegram row is written only if the user completed a verified link.
  - The deduplication key is `match:{goal}:{matchKey}:{total}:{channel}` (UNIQUE).
  - An unchanged result never re-alerts. A new alert is sent in three cases:
    - **The flight changed** (user decision). A different flight number on either leg, or a different departure date, alerts at once, even within the cooldown. The alert says what changed: "پرواز رفت: قبلاً ZV 4030، حالا W5 1234". Provider fare ids are ignored, because they can change while the flight stays the same.
    - **A price improvement of ≥ 5 %.**
    - **A different option (for example, a hotel-only change) after the 24 h cooldown.**
  - A → B → A alerts again, because the user was last told B. The same result after the same previous alert is stored only once, since the dedup key includes the previous alert id. Checks run at most every 6 h, so flapping is bounded to about 4 alerts a day.
- **Message:** the alert text gives the goal, the dates, the flight and hotel, the total in Toman, the provider and the check time in Tehran time. It ends with the note "این رزرو نیست؛ قیمت ممکن است تغییر کند".
- **Telegram linking:**
  - `/telegram link` creates a one-time, 8-character code. It is stored as sha256 and is valid for 15 minutes, and the command shows the `t.me/<bot>?start=CODE` link.
  - The user sends the code to the bot from their own Telegram account. `/telegram verify` then reads `getUpdates` and accepts only `/start CODE` from a **private** chat that matches this user's unused, unexpired code.
  - A chat id typed by anyone is never accepted as proof of ownership.
- **Outbox delivery:**
  - Delivery claims rows with SKIP LOCKED and marks them `sending`. A row becomes `sent` **only when the Bot API answers `ok: true`**.
  - A 429 is retried after its `retry_after`, and a 5xx or network error with exponential backoff. A 4xx (for example, the bot was blocked) is marked `failed`.
  - A timeout after the request was sent is ambiguous. It is retried once and then marked `unknown`, so the user is not spammed and nothing is claimed as delivered.
  - A row stuck in `sending` for more than 10 minutes becomes `unknown`.
- `/telegram test` (or `peyva:goals telegram test`) is the explicit live test of the full path: it queues one test row in the outbox, delivers it, and reports the status **as stored**. It reports success only for `sent`.
- The bot token is validated, used only in the request URL, and scrubbed (`***`) from every stored or logged error.

## 10. How to run

```bash
bun install
bun run db:start                # terminal 1: embedded PostgreSQL in ./.pgdata; copy the printed PEYVA_DATABASE_URL into .env
bun run peyva:chat              # terminal 2: chat; "…اگه پیدا شد خبرم کن" → approve with «بله»
bun run peyva:goals create --origin تهران --destination کیش --depart "۱۹ آذر ۱۴۰۵" --nights 3 --adults 1 --rooms 1 --budget "۳۰ میلیون"
bun run peyva:worker --once     # one real check (MrBilit), or `bun run peyva:worker` to keep running
bun run peyva:goals list | show N | pause N | resume N | cancel N | budget N "۲۰ میلیون" | notifications | prefs
```

The same commands work inside the chat: `/goals`, `/goal N`, `/pause N`, `/resume N`, `/cancel N`, `/budget N <amount>`, `/notifications`, `/prefs`, `/pref …` and `/telegram link|verify|status|test|unlink`. Commands need no LLM, so they use no API quota. In the chat, `/trip` shows the current conversation goal (it was `/goal` in Phase 2).

For a permanent worker on Linux, run `bun run peyva:worker` under a systemd user service. Alternatively, run `peyva:worker --once` from a timer every hour; due goals are still checked only every ≥ 6 h.

## 11. Safety and privacy summary

- There is no booking or payment. Provider use is read-only, the MCP project is used within its educational scope, and anti-bot, geo and proxy settings are never bypassed (`*_MCP_PROXY` is never set).
- Provider text is untrusted. It is cleaned of control and bidi characters before it reaches the LLM, notifications or the terminal, and it cannot trigger actions (tested).
- The LLM can propose but cannot activate, save, cancel or claim delivery. Every state change is made and reported by code from the database.
- Only whitelisted preferences are stored, with no sensitive categories and no inferences. Every query is scoped by user.
- Secrets stay only in `.env`, which is git-ignored. They are not stored in the database or the logs. Database URLs are printed with the password redacted.
- Automated tests never send real messages. Telegram is a local fake server (`test/support/fake-telegram.ts`), and the provider is replayed from recordings.

## 12. Tests, limits and next steps

`bun run test` gives 110 tests, all passing:

- 68 Phase 2 tests.
- `db` (3): the check constraint and a real server restart.
- `memory-goals` (14).
- `worker` (19): claiming, crash recovery, retries, timeout, pause during a run, dedup and cooldown, flight-change alerts, Telegram linking and delivery states, token scrubbing, injection.
- `phase3-chat` (6): LLM draft → code approval, "no" and unrelated replies, the false-claim guard, preferences, slash commands, the no-database mode.

`bun run typecheck` is clean. Tests use a real embedded PostgreSQL 18 (`test/support/pg.ts`).

A smoke test on the dev VM used a real database, the goals CLI create → approve → list, and `worker --once` against live MrBilit. The worker recorded `PROVIDER_ERROR (network_or_geo_block)` with a 15-minute retry, and `show` displayed the last failure separately from the last success.

**Known limits:**
- Live Telegram delivery is not yet verified.
- There is one provider (MrBilit) and one executor.
- The hotel recordings used in tests cover only 3-night stays.
- There is no authentication, by design (single-user).
- The worker runs only while your machine is on.

**Next:** run one live check and one live Telegram test on the Omarchy machine. Then decide whether a second executor or a second provider brings more learning value.
