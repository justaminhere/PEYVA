# PEYVA — v1 Launch Hardening Spec
Status: Ready (two Assumptions below are settled in Milestone 0; they do not block starting)

## 1. Summary
PEYVA is an AI-native Persian agent for Iranian online services; travel is the first vertical (MrBilit search, deterministic comparison, price monitoring). v1 takes the existing public MVP from "anonymous demo" to a **small real launch for about 5 invited users**: email magic-link login, hard protection of the owner's LLM bill, and strict isolation of each user's data. No new service verticals.

## 2. Problem & evidence
- **Confirmed:** PEYVA started as a Bozhan course demo; the owner now wants to show it to real users and pays for the LLM themselves. No deadline.
- **Confirmed (code/docs):** `docs/DEPLOY_MVP.md` says the public mode is "not yet deployed or run on a real platform"; the Docker image was never built and MrBilit was never called from a cloud IP.
- **Confirmed (code/docs):** visitors are anonymous signed cookies; clearing cookies loses all data. Quotas live in memory and reset on restart, so a crash loop or redeploy resets the spend caps.
- **Confirmed (Phase 4B):** 8 of 35 LLM turns failed (rate limits, network, bad request, iteration limit).
- **Owner's top worries:** (1) LLM cost running away, (2) data leaking between users.
- **Assumption:** 5 users is the real size of the first launch; the system is not designed for more yet.

## 3. Users & context
- ~5 invited Persian-speaking people, on phone or desktop browsers, online.
- Access is by email magic link. Only invited emails may sign in.
- Hosting: Liara (Docker, `liara.json` exists). **Assumption:** Liara is final and the current LLM provider is reachable from it.

## 4. Main journey
1. The owner adds an email to the allowlist.
2. The user opens the site, enters their email, and receives a magic link.
3. They click it and are signed in (session cookie, 30 days).
4. They chat to build a trip goal, see results, and start a price watch.
5. The worker monitors in the background; alerts appear in the web app.
6. They return days later on any device, sign in with a new magic link, and see the same goals and history.
7. If they hit a limit, they see a clear Persian message, not an error.

## 5. Scope
**v1:** magic-link login with allowlist; per-user data isolation, proven by tests; persistent spend caps; global kill switch; deployment on Liara with a real MrBilit and LLM smoke test; safe handling of LLM failures; user data deletion.

**Later:** Divar, Digikala and other verticals; Telegram alerts for public users; open signups; payments or booking; abuse tooling beyond the allowlist.

**Out of scope:** booking, payment, passwords, social login, an admin dashboard (the owner uses CLI or SQL).

## 6. Requirements

### R1 — Magic-link login
Behavior: A user enters an email; if it is on the allowlist, a single-use link is emailed. Clicking it creates a signed session cookie (HttpOnly, Secure, SameSite=Lax) tied to a user id derived from the email.
Acceptance:
- [ ] A link works once and expires after 15 minutes.
- [ ] A non-allowlisted email gets the same response as an allowlisted one (no email enumeration), and no mail is sent.
- [ ] A forged, expired or reused link shows a Persian error and creates no session.
- [ ] At most 5 link requests per email and per IP per hour.
- [ ] Logging out invalidates that session server-side.
Edge/error cases: email provider down → the user sees "try again later" and the failure is logged; user clears cookies → signs in again and gets all their data back.

### R2 — Data isolation
Behavior: Every row (goals, memory, conversations, alerts, usage) belongs to one user id, and every query is scoped by it.
Acceptance:
- [ ] An automated test with two users proves that user A cannot read, change or delete B's goals, conversations, alerts or memory through any HTTP route, including by guessing ids.
- [ ] Logs and error messages never contain another user's data or any secret.
- [ ] A user can delete their account and all their data from the UI. A test confirms nothing remains.
Edge/error cases: an unauthenticated request to an API route → 401, with no data.

### R3 — Persistent spend control
Behavior: Daily and monthly LLM budgets are stored in PostgreSQL, not memory, and survive restarts and redeploys.
Acceptance:
- [ ] Per-user daily limits (turns, searches, tokens) and a site-wide daily and monthly token cap are enforced from the database.
- [ ] A restart in the middle of the day does not reset the counts (tested).
- [ ] When the monthly cap is reached, new LLM turns are refused with a Persian message, while non-LLM features (viewing goals and alerts) keep working.
- [ ] One env var (`PEYVA_KILL_SWITCH=1`) turns off all LLM calls immediately.
- [ ] The cap is checked before every LLM and provider call, and each turn's reported token usage is recorded.
Edge/error cases: usage not reported by the provider → fall back to a conservative estimate; the database is down → refuse LLM calls (fail closed).

### R4 — Resilience to LLM and provider failure
Behavior: Failures never leave the user stuck or lose their work.
Acceptance:
- [ ] On rate limit or network error, one retry with backoff, then a clear Persian message with a retry button; no half-saved goals.
- [ ] While the LLM is down, the user can still see goals and alerts and re-run a search with no LLM involved (the existing manual search).
- [ ] If MrBilit fails or blocks the server, the UI says so, and the worker does not mark goals as failed or send false alerts.
Edge/error cases: iteration-limit hit → the message says what was understood so far.

### R5 — Deployment and smoke test
Behavior: The app runs on Liara and passes a real end-to-end check.
Acceptance:
- [ ] The Docker image builds and starts; `/api/health` is green.
- [ ] From the Liara server, one real MrBilit search and one real LLM turn succeed.
- [ ] A magic-link email arrives from the chosen provider.
- [ ] The worker survives a restart and resumes due goals.
- [ ] `bun run check:secrets`, `bun run test` and `bun run typecheck` pass; no secret is in the repo or in logs.
Edge/error cases: deploy with missing env vars → the app refuses to start with a clear message.

### R6 — Privacy basics
Behavior: Users know what is stored, and the owner stores little.
Acceptance:
- [ ] A short Persian notice states that email, goals and chats are stored, who can see them, and how to delete them.
- [ ] Only the email, goals, preferences, conversations and usage counters are stored; nothing else.
Edge/error cases: none.

## 7. Data & integrations
- **Entities:** `users` (id, email, created_at, allowed), `login_tokens` (hashed token, email, expires, used), `sessions` (id, user_id, expires), `usage_daily` (user_id, date, turns, searches, tokens), `usage_site` (date, tokens); existing goals, memory, conversations and alerts get a `user_id` that already exists as the visitor id and migrates to the user id.
- **MrBilit (via `mrbilit-mcp`):** works locally (Phase 1 / 4A verification). **Not verified** from Liara.
- **LLM provider (OpenAI-compatible, key in env):** works locally. **Not verified** from Liara.
- **Email provider:** **not chosen, not verified** (Resend, Brevo or SMTP). Reachability from Liara, and delivery to Iranian mail providers such as Gmail and Yahoo, are unknown.

## 8. Technical decisions
- Keep the current stack: Bun, TypeScript, Hono, React, PostgreSQL, Docker. It exists and works.
- PostgreSQL for sessions, tokens and quotas: it is already the store, and it survives restarts.
- Magic link, not passwords: nothing sensitive to store or leak. Tokens are stored hashed.
- Allowlist, not open signup: it bounds cost and abuse at ~5 users.
- Fail closed on the budget: a broken counter must never mean unlimited spend.

## 9. Milestones

### Milestone 0 — Feasibility (before any code)
**Delivers:** answers on the four unverified items: image builds on Liara; MrBilit works from Liara; LLM works from Liara; the email provider sends and delivers.
**Verified by:** a short note with the result of each, and a choice of email provider.
**You'll see it working when…** a real search and a real email each work from the live Liara URL.

### Milestone 1 — Login and isolation
**Delivers:** R1, R2 (and the user id migration).
**Verified by:** the two-user isolation tests, login and token tests, and a manual login on a real device.
**You'll see it working when…** you sign in by email on your phone, and a second account sees none of your data.

### Milestone 2 — Spend control and failure handling
**Delivers:** R3, R4.
**Verified by:** restart tests, a forced monthly cap, a kill-switch test, and failure injection for the LLM and MrBilit.
**You'll see it working when…** you restart the server and the counts persist, and a simulated outage shows a friendly message.

### Milestone 3 — Launch readiness
**Delivers:** R5, R6, account deletion, and the invite of 5 users.
**Verified by:** the full smoke test on Liara, then 5 real users each plan a trip and create a watch without help for a week.
**You'll see it working when…** all 5 users finish the journey, no cross-user data appears, and the LLM bill stays under your cap.

## 10. Decisions & assumptions
**Decisions (Confirmed by owner):** harden travel only; Divar, Digikala and others later; ~5 users; email magic-link login; the owner pays for the LLM; no deadline; data isolation and the LLM bill are the top concerns.
**Decisions (by me, reversible):** invite-only allowlist; the quota store moves to PostgreSQL; the kill switch is an env var; the magic-link TTL is 15 minutes.
**Assumptions:** Liara is the final host and reaches the LLM provider; 5 users is the real scale; the success bar is "5 users finish the journey with no help and nothing breaks for a week" (proposed by me; the owner did not give a different bar).

## 11. Open questions & risks
- Which email provider, and does it deliver to the testers' addresses? (Milestone 0.)
- Does MrBilit block or rate-limit Liara's IPs? If it does, the whole launch is blocked; the fallback would be to run the server somewhere else, or to route requests another way.
- MrBilit is accessed by an unofficial MCP; its terms and stability are not guaranteed. This is acceptable for 5 users, but it needs a check before any wider launch.
- Is the LLM provider's free tier, or its rate limit, enough for even 5 users? Check against the limits in R3.
- Telegram alerts stay off for public users; alerts exist in the web app only.
