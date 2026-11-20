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

## 4. Reductions (1–3 implemented 2026-11-20, see §6; 4 not yet)

| # | Change | Fixed tokens involved | Saving | Effect on safety |
|---|---|---:|---|---|
| 1 | Shrink `update_trip_goal`: dates and months only as `{"text": …}`; remove the number-based date forms and long descriptions | 1,665 (a part of it is saved) | large, every request | **safer**: the live month bug came from the number-based form |
| 2 | Hide `search_flights` / `search_hotels` from the LLM in chat; `compare_trip_options` covers the main path; the code stays | 986 (all of it) | every request | none |
| 3 | Compact history: replace earlier tool results with a short summary (the current goal is already in the system prompt) | grows with the conversation | grows with every turn | none |
| 4 | Record and replay real LLM responses for regression tests | — | tests use no quota | none |

None of the deterministic checks (cross-check against the user's words, month mismatch, price/date/action guards, freshness)
depends on the token-heavy parts, so all four keep them intact.

## 6. Results of proposals 1–3 (implemented)

What changed:
- **1:** the LLM gets `LlmGoalPatchSchema`. Dates and months are `{"text": …}` only, with shorter descriptions. The internal `GoalPatch`
  keeps the structured forms for code and tests. A number-based date from the LLM now fails validation, so the live month bug can no
  longer even be expressed.
- **2:** the chat LLM is offered 2 tools (`update_trip_goal`, `compare_trip_options`). `search_flights` / `search_hotels` stay in code,
  still validated, available to a `ToolRunner` created with `tools: "all"`. In chat, a call to them is rejected as an unknown tool.
- **3:** `compactHistory()` replaces tool results from earlier turns with short summaries before each request. Message count and
  tool-call ids are unchanged, and the current turn's results stay complete.

Measured (estimates at characters ÷ 3.5; real token counts still need a live run):

| Measure | Before | After | Change |
|---|---:|---:|---:|
| Fixed per request (`peyva:token-budget`) | 12,485 chars ≈ 3,567 tok | 5,240 chars ≈ 1,497 tok | −58% |
| `update_trip_goal` definition | ≈ 1,665 tok | ≈ 638 tok | −62% |
| History sent at turn 5 of the scripted conversation | 7,602 chars | 3,435 chars | −55% |
| Whole 5-turn conversation, 12 requests (`test/token-diet.test.ts`) | 194,673 chars ≈ 55,600 tok | 86,463 chars ≈ 24,700 tok | −56% |

Against the free tier (best case, same caveats as §3):
- At ≈ 2,060 tokens per request on average (24,700 / 12), about 3.9 requests fit in a minute, so a 2–3 request turn should no longer
  hit the per-minute limit.
- A full 5-turn test conversation uses ≈ 12% of the daily 200,000 tokens instead of ≈ 28%.

Behaviour: all 62 agent tests and 35 spike tests pass, and the scripted conversation ends with the same deterministic 4★ total
(28,681,300 Toman).

## 7. Live measurement after the diet (chat 3, 2026-11-20 15:12–15:19 UTC)

Evidence: `evidence/phase2a/chat-live-3-groq-qwen-token-diet.jsonl`. Real token counts come from the API's `usage` field.

| Turn | Requests | Prompt tokens per request | Request latencies | Turn |
|---|---:|---|---|---:|
| «می‌خوام یه سفر سه شبه به کیش برم» | 2 | 1,759 / 1,982 | 1.3 / 0.4 s | 1.7 s |
| «تهران، یک نفر، بودجه ۳۰ میلیون» | 3 | 1,896 / 2,162 / 2,476 | 0.6 / 0.7 / 0.8 s | 2.1 s |
| «۱۹ آذر ۱۴۰۵» (+ real searches, compare) | 3 | 2,165 / 2,475 / 2,773 | 0.4 / **9.1 / 15.8 s** | 33.6 s |
| «فقط هتل چهار ستاره به بالا باشه» (compare) | 4 | 2,552 / 2,854 / 3,140 / 3,437 | 0.5 / 0.5 / **13.9 / 29.4 s** | 44.3 s |
| «اگه قیمت مناسب شد بهم خبر بده» | 1 | — | HTTP 429, daily limit (TPD 198,053 of 200,000 used) | 0.4 s |

- **Real vs estimate:** 12 successful requests used 29,671 prompt and 601 completion tokens, on average **2,473 prompt tokens per
  request**. The first request (fixed cost + a short message) was 1,759 tokens against the 1,497 estimate, so characters ÷ 3.5
  under-counts by about 15%; ≈ 3.0 characters per token fits this prompt better.
- **Latency:** clarification turns now take ~2 s, against 16–25 s before the diet. Comparison turns still take 33–44 s. There, single
  requests with tiny outputs took 9–29 s, which is consistent with waiting on the per-minute token limit: 3–4 requests of 2.5–3.4k
  tokens within a minute exceed 8,000 TPM. That last part is an inference, since the run did not log retry headers.
- **Daily limit:** the day's earlier test runs had used almost all 200,000 tokens, so turn 5 got a 429. The reply was honest, but
  the turn ended before the app's own checks ran, so the monitoring wish was not recorded. Fixed: the deterministic checks now run on
  every exit of a turn, and the rate-limit reply names the limit (daily or per minute) and the wait time.
- **Wasted request:** in turn 4 the model first sent `update_trip_goal({})`. Empty updates are now refused, and the prompt forbids them.

## 5. How to verify a change

1. `bun run peyva:token-budget` before and after: the fixed estimate must drop as expected.
2. `bun run test`: replay and unit tests must still pass. Proposal 1 changes the tool schema, so tests that send number-based dates
   must move to `{"text": …}` or test the rejection.
3. One live `peyva:chat` run. In `output/sessions/chat-*.jsonl`, `llmCalls[].usage.prompt` gives the **real** prompt tokens per
   request and `llmCalls[].ms` the latency. Put the measured values into the spreadsheet.
