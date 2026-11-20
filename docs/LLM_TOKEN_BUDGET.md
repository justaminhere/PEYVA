# PEYVA: LLM Token Budget on a Free API Tier

- **Date:** 2026-11-20
- **Context:** live tests of `peyva:chat` run on Groq's free tier (`qwen/qwen3.8-27b`). Test runs are limited, and turns took
  16–151 s in live chat 2 (`evidence/phase2a/chat-live-2-groq-qwen.jsonl`).
- **Question:** where do the tokens go, and how can PEYVA use fewer of them without weakening its safety checks?
- **Spreadsheet version:** "PEYVA – بودجهٔ توکن و صرفه‌جویی (Groq رایگان)" (https://claude.ai/artifact/4GueHadqidyiEAzXdSVjFP).
  Its conclusions are formulas, so replacing an estimate with a measured value updates them.

## 1. Fixed cost of every request

Every LLM request sends the system prompt (with the current goal) and all tool definitions **before** any conversation history.
Measured with `bun run peyva:token-budget` (no network, no key). Tokens are an **estimate**: characters ÷ 3.5. Persian text
usually costs more tokens per character, so the real values may be higher.

| Part | Characters | ≈ Tokens |
|---|---:|---:|
| System prompt + goal state (empty goal) | 2,694 | 770 |
| Tool `update_trip_goal` | 5,828 | 1,665 |
| Tool `compare_trip_options` | 383 | 109 |
| Tool `search_flights` | 1,412 | 403 |
| Tool `search_hotels` | 2,039 | 583 |
| Tool wrapper overhead | 129 | 37 |
| **Total fixed per request** | **12,485** | **3,567** |

On top of this, each request re-sends the whole conversation, including every earlier tool result (goal + analysis, comparison
summaries), so the cost grows with each turn. One user turn takes 2–3 requests (live logs).

## 2. Groq free-tier limits

Source: https://console.groq.com/docs/rate-limits. The row for `qwen/qwen3.8-27b` reads "30 | 1K | 8K | 200K". The column order
is **my reading** of the table and has not been confirmed:

| Limit | Value |
|---|---:|
| Requests per minute (RPM) | 30 |
| Requests per day (RPD) | 1,000 |
| Tokens per minute (TPM) | 8,000 |
| Tokens per day (TPD) | 200,000 |

Groq applies limits per organization, and whichever limit is reached first applies.

## 3. What follows (fixed cost only, i.e. best case)

| Measure | Value | Formula |
|---|---:|---|
| Requests per minute before hitting TPM | ≈ 2.2 | 8,000 / 3,567 |
| Requests per day before hitting TPD | ≈ 56 | 200,000 / 3,567 |
| Requests per turn (worst case seen) | 3 | live logs |
| Conversation turns per day (upper bound) | ≈ 18.7 | 56 / 3 |

**Interpretation:** a single turn of 2–3 requests already reaches the per-minute token limit. The `openai` SDK then waits and retries
(`maxRetries: 1`), which very likely explains the 78–151 s turns. That is a hypothesis: the run did not log retries. The daily token
limit, not the request limit, caps testing at well under 20 turns a day.

## 4. Planned reductions (not implemented yet)

| # | Change | Fixed tokens involved | Saving | Effect on safety |
|---|---|---:|---|---|
| 1 | Shrink `update_trip_goal`: dates and months only as `{"text": …}`; remove the number-based date forms and long descriptions | 1,665 (a part of it is saved) | large, every request | **safer**: the live month bug came from the number-based form |
| 2 | Hide `search_flights` / `search_hotels` from the LLM in chat; `compare_trip_options` covers the main path; the code stays | 986 (all of it) | every request | none |
| 3 | Compact history: replace earlier tool results with a short summary (the current goal is already in the system prompt) | grows with the conversation | grows with every turn | none |
| 4 | Record and replay real LLM responses for regression tests | — | tests use no quota | none |

None of the deterministic checks (cross-check against the user's words, month mismatch, price/date/action guards, freshness)
depends on the token-heavy parts, so all four keep them intact.

## 5. How to verify a change

1. `bun run peyva:token-budget` before and after: the fixed estimate must drop as expected.
2. `bun run test`: replay and unit tests must still pass. Proposal 1 changes the tool schema, so tests that send number-based dates
   must move to `{"text": …}` or test the rejection.
3. One live `peyva:chat` run. In `output/sessions/chat-*.jsonl`, `llmCalls[].usage.prompt` gives the **real** prompt tokens per
   request and `llmCalls[].ms` the latency. Put the measured values into the spreadsheet.
