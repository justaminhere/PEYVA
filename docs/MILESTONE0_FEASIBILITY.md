# Milestone 0: feasibility check (2026-11-22)

Scope: the four unverified items in SPEC.md §7, checked against the live Liara app (`peyva.liara.run`) and this development machine. Read-only; it used 4 chat turns on the live site (3 flight searches).

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Image builds and runs on Liara | **Verified** | `GET /api/health` returns `{"ok":true}`, HTTP 200; the app answers `/api/state` and `/api/chat`. |
| 2 | LLM works from Liara | **Verified** | A live turn ("سلام") returned `source: llm`, `llmError: null`, a streamed Persian reply. The key set on Liara works. |
| 3 | MrBilit works from Liara | **Verified (owner test)** | The owner searched another city on the live site and it returned results. My first reading (Liara blocked) was wrong: the three searches I ran (THR→KIH 10 and 11 Dec, THR→MHD 16 Dec) returned `compare candidates: 0` because MrBilit had no hotel for those dates, not because Liara was blocked. |
| 4 | Email provider | **Not tested, not chosen** | Nothing to test yet; see below. |

## Finding 1 (corrected): empty results look like a block
The earlier diagnosis (MrBilit blocks Liara) was wrong. When no hotel exists for the dates, the app says "no options listed" and the comparison shows 0 candidates, even for a flight-only ask. The user cannot tell "no hotel for these dates" from "the provider is down". Fix as part of R4 in SPEC.md: say what was missing (flights or hotels, for which dates) and offer nearby dates. Not yet checked: whether a flight-only request should show flights when no hotel exists.

## Finding 2: the local LLM key is dead
`bun run peyva:llm-check` here returns `GET /models: HTTP 401`. The key in the local `.env` is invalid (likely rotated). The key on Liara works. Local development and the tests that call the LLM need a new key. Also, `docs/DEPLOY_MVP.md` says Groq blocks Iranian IPs, yet the Liara app's LLM works. Check which endpoint Liara's `PEYVA_LLM_BASE_URL` actually points at, and record it.

## Email provider (not tested)
Needs an account and an API key, which are yours to create. Shortlist to test from Liara: Resend, Brevo, or SMTP from your own mail host. Test: send one message from the Liara container to a Gmail and a non-Gmail address, and check that it arrives and is not in spam. If a foreign HTTPS API is unreachable from Liara, use an SMTP relay that is reachable from Iran.

## Verdict
Items 1 and 2 pass. Item 3 passes, confirmed by the owner. Milestone 0 is closed except the email provider, which needs your account and key. Milestone 1 can start; do the email test first or alongside it.
