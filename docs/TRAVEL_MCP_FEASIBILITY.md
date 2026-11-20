# PEYVA Phase 1: Iranian Travel MCP Feasibility Spike

- **Date:** 2026-11-20
- **Scope:** Can PEYVA consume genuine, structured flight and hotel data from existing Iranian MCP servers?
- **Code:** [`experiments/travel-mcp-spike/`](../experiments/travel-mcp-spike/)
- **Evidence:** `experiments/travel-mcp-spike/evidence/2026-11-20-omarchy-live/` (live, VERIFIED) and `…/2026-11-20-sandbox/` (sandbox, failed)

## 1. Verdict

**Phase 1 definition of done: MET, through MrBilit.** On 2026-11-20 08:52 UTC the CLI, run on the developer's
Omarchy machine (network in Germany), obtained real flight and hotel data for the Tehran → Kish scenario from
`mrbilit-mcp` 0.5.2. One flight price was independently cross-checked against the mrbilit.com results page and matched.
FlyToday was **not** reachable from the same network (§4).

| DoD item | Status |
|---|---|
| 1. Connect programmatically to an Iranian travel MCP server | **VERIFIED** (both servers, TypeScript, official MCP SDK, stdio) |
| 2. Discover and invoke its real tools | **VERIFIED** (MrBilit: 6/6 calls ok). FlyToday: discovery only |
| 3. One genuine flight result and one genuine hotel result | **VERIFIED**: 5 outbound + 6 return flights, 20 hotels (MrBilit) |
| 4. Convert results to a consistent TS model without invention | **VERIFIED** for MrBilit real data (31 rows, 0 issues). FlyToday NOT TESTED |
| 5. Reproduce from a documented CLI command | **VERIFIED**: `bun run src/cli.ts run mrbilit` |

**Recommendation: CONDITIONAL GO.** The integration approach works technically. Product work should **not** start
on these servers until:

1. **License:** PolyForm **Noncommercial** (§7). A commercial PEYVA needs a commercial license from the author,
   or official provider APIs.
2. **ToS / anti-bot posture** of unofficial endpoints with Chrome TLS impersonation is accepted, or replaced (§7).
3. **Reliability** is measured over more than one run (§6: DNS for `hotel.mrbilit.ir` failed once, minutes earlier).

## 2. Environment actually used

Development, tests and the first runs happened in a sandboxed Linux VM attached to the PEYVA folder (table below).
The **live** run was executed by the developer on the Omarchy machine `funlife` (Linux x64, network in Germany)
with the same code. See §4.

| Item | Value |
|---|---|
| OS | Ubuntu 22.04.5 (sandbox VM), kernel 6.8 |
| Bun | 1.4.5 (installed from the npm registry into the sandbox) |
| Node | 22.23.4 |
| Python | 3.10.12 |
| uv / uvx | 0.13.4 |
| MCP TS SDK | `@modelcontextprotocol/sdk` 1.32.2 |
| Servers | `mrbilit-mcp==0.5.2`, `flytoday-mcp==0.4.2` (Python `mcp` 2.3.0, `curl_cffi` 0.17.0) |
| PEYVA folder | empty before the spike; **not a git repository** (`git status`: not a git repository) |

Network as measured:

| Destination | Result |
|---|---|
| github.com, registry.npmjs.org, pypi.org (via sandbox proxy) | reachable |
| www.mrbilit.com, api.mrbilit.com, www.flytoday.ir, bun.sh (via sandbox proxy) | `403 Forbidden`, `X-Proxy-Error: blocked-by-allowlist` (VM); the cloud workspace answered the same hosts with `403 … no rule or network setting allows this host` |
| Any host directly, bypassing the proxy (including github.com) | DNS fails: `getaddrinfo EAI_AGAIN` |

Both servers ignore `HTTPS_PROXY` by design and connect directly. So in this sandbox they cannot reach any
host at all. The proxy block is a policy of this session's egress allowlist and was not routed around.

## 3. Upstream review

Repository `sepehr071/iran-mcp` at `923b2cb` (2026-11-19). Server repos: `sepehr071/mrbilit-mcp` at `ba266dc`,
`sepehr071/flytoday-mcp` at `5708aad`. Read: `README.md`, `AGENTS.md`, `servers.json`, `LICENSE`, each
server's `README.md`, `pyproject.toml` and source (`http.py`, `flights.py`, `hotels.py`, `places.py`).

| | mrbilit-mcp | flytoday-mcp |
|---|---|---|
| Version / install | 0.5.2, `uvx mrbilit-mcp` (PyPI) | 0.4.2, `uvx flytoday-mcp` (PyPI) |
| Transport | stdio | stdio |
| Tools | 22, all `readOnlyHint: true` | 22, all `readOnlyHint: true` |
| Auth | none | none |
| `outputSchema` | none (shape only from source) | none (shape only from source) |
| Backends | `flight.atighgasht.com`, `hotel.mrbilit.ir`, `*.mrbilit.ir` (undocumented site APIs) | `api.flytoday.ir`, `placesearch.flytoday.ir`, `www.flytoday.ir` (undocumented site APIs) |
| Currency | Toman in `*_toman` (API Rial // 10) | Toman in `*_toman` (API Rial // 10) |
| Flight price | `price_toman` per adult, `total_toman` party | `price_toman` per adult, `total_toman` party |
| Hotel price | `price_toman` = cheapest room, **whole stay, one room**; independent of guest count | `price_toman` = **whole stay** (single room for `adults`), plus `per_night_toman` |
| Booking / source URL in results | none | none |
| Documented rate limits | max 2 concurrent requests with jitter; retries 5xx/429 twice | per IP: about 15 flight searches; hotel captcha after about 12 searches in 10 min, blocked for 1 h+ |
| Outside Iran | "MrBilit's API resets connections from many networks outside Iran" (error text in `http.py`) | `AGENTS.md`: on timeouts or 403 outside Iran, set the proxy env |

Tool signatures discovered via `tools/list` (saved in `evidence/…/tools-*.json`):

- `mb_find_place(query*, mode* ∈ flight|train|bus|taxi|hotel, limit)`
- `mb_search_flights(origin*, destination*, date*, return_date, adults, children, infants, cabin, sort, airlines, direct_only, depart_after, depart_before, limit)`. `origin`/`destination` pattern `^[A-Za-z]{3}(ALL)?$`
- `mb_search_hotels(city*, check_in*, check_out*, sort, min_stars, hotel_type, max_price_per_night_toman, refundable_only, amenities, breakfast_only, limit)`. `city` is a slug from `mb_find_place(mode="hotel")`
- `ft_find_airport(query, domestic_only, limit)`, `ft_find_hotel_place(query, international, limit)`
- `ft_search_flights(origin*, destination*, date*, return_date, adults, …, page, search_id, outbound_key)`
- `ft_search_hotels(check_in*, check_out*, city_id, region_code, adults=2 (!), children_ages, …, limit, page)`.
  The default is **2 adults**, so the spike passes `adults: 1` explicitly.

## 4. Provider-by-provider results

### Live run on the developer's machine (2026-11-20, VERIFIED)

Machine `funlife` (Omarchy, Linux x64), network in Germany. Command: `bun run src/cli.ts run mrbilit`.
First, a preflight run 10 minutes earlier had failed DNS for `hotel.mrbilit.ir` (`EAI_AGAIN` after 27 s); the next one passed.
The first `run` attempt only paused at server launch because `uvx` was installing on first use. A separate
`uvx --from mrbilit-mcp==0.5.2 python -c "import mrbilit_mcp"` fixed that.

| Call | Params | Latency | Result |
|---|---|---|---|
| `mb_find_place` | `{query:"تهران", mode:"flight"}` | 2842 ms | VERIFIED: `THR` (Mehrabad) and `THRALL` city with THR, IKA |
| `mb_find_place` | `{query:"کیش", mode:"flight"}` | 179 ms | VERIFIED: `KIH` confirmed |
| `mb_find_place` | `{query:"کیش", mode:"hotel"}` | 645 ms | VERIFIED: exactly one city `{id:36, slug:"kish"}` |
| `mb_search_flights` | `THR→KIH, 2026-12-10, adults 1` | 1324 ms | VERIFIED: 5 priced flights, `not_on_sale: 3` |
| `mb_search_flights` | `KIH→THR, 2026-12-13, adults 1` | 790 ms | VERIFIED: 6 priced flights, `not_on_sale: 2` |
| `mb_search_hotels` | `kish, 2026-12-10→12-13, sort cheapest, limit 20` | 3518 ms | VERIFIED: 20 of 26 available (truncated by `limit`) |

Results (Toman, checked 2026-11-20 08:52 UTC; prices change constantly):

- Cheapest outbound: Zagros ZV 4030, 06:00→07:45, **10,594,200** per adult (= party total), 9 seats, 20 kg.
- Cheapest return: Zagros ZV 4031, 11:45→13:30, **10,794,100**, 9 seats.
- Cheapest hotel: Paniz (هتل پانیذ, 2★, id 10977), **3,726,000 for 3 nights, one room** (provider per night 1,242,000; breakfast; non-refundable; room sleeps 2).
- Deterministic package sum: 10,594,200 + 10,794,100 + 3,726,000 = **25,114,300 Toman** (recomputed by hand).

Independent cross-check: `https://mrbilit.com/flights/THR-KIH?departureDate=2026-12-10&adultCount=1&childCount=0&infantCount=0`
opened in a browser on the same machine shows Zagros 06:00, 9 seats, **10,594,200 تومان**. That confirms the value and the Toman unit.
The site lists one more card (Kish Air 17:30 business fare, 23,764,000). The MCP returns only the cheapest fare per flight, which is consistent.

Normalization checks on real data: all 11 flights and 20 hotels `dataStatus: "live_search"`, `issues: []`. For every hotel,
provider `nights` = 3 = computed nights and `per_night_toman` ≈ `price_toman / 3`. All prices are integers in Toman.
Fields not mapped yet: baggage, charter flag, aircraft, meals, photo.

### FlyToday from the same machine

`bun run src/cli.ts preflight`: `www.flytoday.ir` and `placesearch.flytoday.ir` reach TLS. **`api.flytoday.ir` resolves to
`172.22.3.13`**, a private RFC 1918 address, and the connection is refused (`ECONNREFUSED`, 139 ms). The search API host
is therefore unusable from this network. Two hypotheses are still open: the provider's DNS returns an internal address
to non-Iranian resolvers (geo-DNS), or a local resolver/VPN/Docker network interferes. Next diagnostic:
`dig api.flytoday.ir`, `dig @1.1.1.1 api.flytoday.ir`, `ip route get 172.22.3.13`. FlyToday searches: **NOT TESTED**.

### Sandbox run (2026-11-20, FAILED — environment)

#### MrBilit (primary), sandbox

| Test | Status | Evidence |
|---|---|---|
| `uvx --from mrbilit-mcp==0.5.2` install | VERIFIED | 35 packages, 41 s cold |
| Stdio connect from TS | VERIFIED | `serverInfo {name: "mrbilit-mcp", version: "0.5.2"}`, 1.9–3.2 s warm |
| `tools/list` | VERIFIED | 22 tools; `mb_search_flights`, `mb_search_hotels`, `mb_find_place` present |
| `mb_find_place` Tehran / Kish (flight) | FAILED: network | `Could not reach flight.atighgasht.com (ConnectError)`, ~3.1 s |
| `mb_find_place` Kish (hotel) | FAILED: network | `Could not reach hotel.mrbilit.ir (ConnectError)`, 2.7 s |
| `mb_search_flights` THR→KIH 2026-12-10 | FAILED: network | `Could not reach flight.atighgasht.com (ConnectError)`, 3.2 s |
| `mb_search_flights` KIH→THR 2026-12-13 | FAILED: network | same, 3.5 s |
| `mb_search_hotels` kish 12-10→12-13 | NOT TESTED | skipped: hotel slug not confirmed by the provider lookup (the spike does not guess) |
| Regional/geo restriction | NOT TESTED | cannot be distinguished from the sandbox block |
| Rate limiting | NOT TESTED | |

#### FlyToday (secondary), sandbox

| Test | Status | Evidence |
|---|---|---|
| `uvx --from flytoday-mcp==0.4.2` install | VERIFIED | 2.6 s (shared deps cached) |
| Stdio connect from TS | VERIFIED | `serverInfo {name: "flytoday-mcp", version: "0.4.2"}`, 1.6–2.9 s |
| `tools/list` | VERIFIED | 22 tools; `ft_search_flights`, `ft_search_hotels`, `ft_find_airport`, `ft_find_hotel_place` present |
| `ft_find_airport` Tehran / Kish | FAILED: network | `Could not reach www.flytoday.ir (ConnectError)`, 2.8–3.2 s |
| `ft_find_hotel_place` Kish | FAILED: network | same, 2.4 s |
| `ft_search_flights` THR→KIH / KIH→THR | FAILED: network | same, 2.6 / 3.1 s |
| `ft_search_hotels` | NOT TESTED | skipped: `city_id` not resolvable without the lookup |
| Regional/geo restriction, rate limit, captcha | NOT TESTED | |

Failure cause, after a small number of diagnostics:

1. Proxy CONNECT to the provider hosts returns `403`, `X-Proxy-Error: blocked-by-allowlist` (VM). In the second
   (cloud) workspace the proxy's status endpoint lists the same hosts under `recentRelayFailures` as a policy denial.
2. A direct connection (`curl --noproxy '*'`) fails at DNS for every host, github.com included.
3. The servers' error texts match (`ConnectError` from `httpx`). Their documented retries account for the ~3 s per call.

Classification: **networking: test-environment egress policy**. Not installation, schema, rate limiting or an
upstream API change. No retries beyond the one direct-call run, no bypass attempts.

### Sample sanitized real responses

Live, from `evidence/2026-11-20-omarchy-live/run-mrbilit/raw/` (first row of each list, abridged):

```json
{"flight_id":"21956337","price_toman":10594200,"total_toman":10594200,"seats_left":9,"cabin":"Economy","charter":false,
 "baggage":"20 KG","segments":[{"from":"THR","to":"KIH","departure":"2026-12-10T06:00:00+03:30","arrival":"2026-12-10T07:45:00+03:30",
 "duration":"01:45:00","stops":0,"flights":["ZV 4030"],"airline":"زاگرس","aircraft":"Airbus A320"}]}
{"id":10977,"name":"هتل پانیذ","hotel":"kish/paniz","type":"هتل 2 ستاره","stars":2,"rating":null,"reviews":0,"address":"میدان پردیس",
 "price_toman":3726000,"per_night_toman":1242000,"meals":"صبحانه","cheapest_room_sleeps":2,"refundable":false}
```

Sandbox error response, `evidence/2026-11-20-sandbox/run-direct-calls/raw/mrbilit-04-mb_search_flights.json`:

```json
{
  "provider": "mrbilit",
  "tool": "mb_search_flights",
  "params": { "origin": "THR", "destination": "KIH", "date": "2026-12-10", "adults": 1, "limit": 15, "sort": "cheapest" },
  "checkedAt": "2026-11-20T08:22:39.982Z",
  "outcome": "tool_error",
  "latencyMs": 3171,
  "error": "Error executing tool mb_search_flights: Could not reach flight.atighgasht.com (ConnectError). MrBilit's API resets connections from many networks outside Iran: set MRBILIT_MCP_PROXY to an HTTP proxy, or check the internet connection."
}
```


## 5. Implementation and what was verified

`experiments/travel-mcp-spike/`: Bun + TypeScript, one runtime dependency (`@modelcontextprotocol/sdk`).

- `McpSession` spawns the pinned server with `StdioClientTransport`. It passes an explicit env allowlist
  (no `*_MCP_PROXY`), applies connect and per-call timeouts, and classifies every call as
  `ok | tool_error | timeout | transport_error`. It never throws for provider failures.
- Strict resolution: flight codes are *confirmed* in the provider's lookup. A hotel city is used only when
  exactly one provider row matches.
- Normalization reads only documented fields. Missing values stay `null`. `currency: "TOMAN"` and a price basis
  (`per_adult`, `whole_stay_one_room`) are explicit on every row. Nights are computed from dates and
  cross-checked against the provider. Inconsistencies mark the row `partial`.
- An empty list is reported as `EMPTY`, distinct from errors. `preflight` avoids wasting rate-limited searches.
- Raw responses are redacted (URL credentials, token/cookie/session/phone/email keys) and scanned. No secrets were found.

Tests (`SPIKE_REAL=1 bun test`): **19 pass, 0 fail**.

| Area | How | Status |
|---|---|---|
| Real server startup + discovery | `test/real-servers.test.ts` with real uvx servers | VERIFIED |
| Empty result, `isError`, timeout (500 ms), server crash, missing binary | `test/fake-server.ts` (test-only) | VERIFIED |
| Normalization, per-night check, nights, shape errors, determinism | **synthetic** fixtures | VERIFIED on synthetic data only |
| Currency interpretation on real data | MrBilit live run, cross-checked against mrbilit.com | VERIFIED (MrBilit) |

Normalized output example from the synthetic test fixture. Real normalized rows: `evidence/2026-11-20-omarchy-live/run-mrbilit/normalized.json`.

```json
{ "provider": "mrbilit", "providerFlightId": "SYN-1", "origin": "THR", "destination": "KIH",
  "departureTime": "2026-12-10T08:00:00+03:30", "price": 1111110, "totalPrice": 1111110,
  "currency": "TOMAN", "priceBasis": "per_adult", "seatsLeft": 4, "availability": "listed",
  "sourceUrl": null, "dataStatus": "live_search", "issues": [] }
{ "provider": "mrbilit", "providerHotelId": "1", "name": "SYNTHETIC HOTEL A", "checkIn": "2026-12-10",
  "checkOut": "2026-12-13", "nights": 3, "providerNights": 3, "totalPrice": 9000000, "providerPerNight": 3000000,
  "currency": "TOMAN", "priceBasis": "whole_stay_one_room", "rating": 4.2, "ratingScale": "0-5", "sourceUrl": null }
```

(`dataStatus: "live_search"` means "parsed from a search endpoint without issues". It is not a claim of real data.)

### Executed commands (abridged)

```bash
git clone --depth 1 https://github.com/sepehr071/iran-mcp.git          # + mrbilit-mcp, flytoday-mcp
uvx --from mrbilit-mcp==0.5.2 python -c "import importlib.metadata …"   # install check
uvx --from flytoday-mcp==0.4.2 python -c "…"
npm install bun                                                       # sandbox only: no bun preinstalled
bun add @modelcontextprotocol/sdk@1.32.2
bun run src/cli.ts tools all          # VERIFIED: 22 + 22 tools, required tools present
bun run src/cli.ts run all            # first run had no preflight yet: 10 real tools/call, all FAILED (network)
bun run src/cli.ts preflight all      # both UNREACHABLE (DNS EAI_AGAIN), exit 3
bun run src/cli.ts run all            # preflight blocks calls, exit 2 "NOT MET"
# --- on the developer's Omarchy machine ---
bun run src/cli.ts preflight          # mrbilit REACHABLE; flytoday UNREACHABLE (api.flytoday.ir -> 172.22.3.13 refused)
uvx --from mrbilit-mcp==0.5.2 python -c "import mrbilit_mcp; print('installed')"
bun run src/cli.ts run mrbilit        # 6/6 VERIFIED, exit 0 "real flight and hotel data obtained"
SPIKE_REAL=1 bun test                 # 19 pass
tsc -p .                              # 0 errors
curl -sv https://www.mrbilit.com      # 403 blocked-by-allowlist (diagnostic)
curl --noproxy '*' https://<host>     # DNS failure for all hosts (diagnostic)
```

## 6. Network, regional and reliability observations

- Both servers ignore system proxies and connect directly. Deployment needs direct outbound access to the
  provider hosts. Container or corporate egress allowlists must include them.
- MrBilit's own error text says its API resets connections from many networks outside Iran. On 2026-11-20 it
  **worked** from the developer's German network: one success, not a guarantee. FlyToday's search API host
  resolved to a private IP from the same network (§4).
- DNS for `hotel.mrbilit.ir` failed once (`EAI_AGAIN`, 27 s) and worked minutes later. Production code needs DNS
  timeouts and retry, and monitoring per backend host.
- Observed live latencies (MrBilit): lookups 0.2–2.8 s, flight search 0.8–1.3 s, hotel search 3.5 s.
  The first `uvx` launch on a new machine installs the server; pre-install it or the 90 s connect timeout may be hit.
- FlyToday per-IP search limits (above) make it unsuitable as a high-volume backend without an official API.
  A shared server IP serving many PEYVA users would hit the captcha quickly.
- Ids expire: MrBilit `flight_id` comes from a fresh search; FlyToday `search_id`/`fare_source_code` last about 15 min.
  Any "monitor and act" feature must re-search before presenting or acting.
- Each failed call costs about 2.5–3.5 s because of the servers' built-in retries. Budget timeouts accordingly. The spike uses 60 s.
- Rial→Toman uses integer division (`// 10`), so up to 9 Rial per amount can be lost. That's negligible for display.
  Keep it in mind if PEYVA ever reconciles against Rial invoices.

## 7. License and terms-of-service

- **License:** `iran-mcp`, `mrbilit-mcp` 0.5.2 and `flytoday-mcp` 0.4.2 are **PolyForm Noncommercial 1.0.0**,
  with the notice "Commercial use needs a separate license" (contact: Sepehr Radmard). Personal research and
  testing are permitted purposes. **A commercial PEYVA would need a commercial license.** The README says
  versions before 0.5.1 were MIT. Whether an old MIT version is usable, and whether it still works against the
  live APIs, has **not** been reviewed or tested.
- **Unofficial:** both servers are unaffiliated with MrBilit/FlyToday and call undocumented website endpoints
  that "can change without notice".
- **Anti-bot posture:** both servers use `curl_cffi` with `impersonate="chrome"` (browser TLS fingerprint) in
  their default HTTP path. They also offer an optional headless-browser extra that clears bot-check pages.
  The spike did not install that extra. The default impersonation is still part of every call. Treat it as a
  compliance risk for any production use.
- **Provider ToS:** the terms pages of mrbilit.com and flytoday.ir could not be fetched from this environment.
  **NOT REVIEWED.**
- **Official alternative:** FlyToday publicly offers a web service (API) for domestic and international flights
  and hotel booking: https://www.flytoday.ir/organization/webservice. No MrBilit partner API was found in this
  spike (limited search).

## 8. Known limitations of this spike

- One live run only (MrBilit, one route, one date). Variants not yet seen in real data: round-trip objects,
  international packages, multi-segment flights, `baggage_to_confirm`, FlyToday rows.
- Hotel availability is "listed by the provider at check time". Neither search result is a reservation or hold.
- Only one-way searches. Domestic round trips are two tickets on MrBilit anyway.
- FlyToday `score` scale undocumented. Ratings are not compared across providers.
- Preflight checks DNS, TCP and TLS only. A post-handshake geo-block or bot check will surface only in `run`.

## 9. Which provider for PEYVA

- **MrBilit is the only provider VERIFIED end-to-end**: flights, hotels, location lookup, Toman semantics confirmed against
  the website. It is the right provider for the next spike steps.
- **FlyToday:** unofficial MCP blocked from this network (`api.flytoday.ir` → private IP) and per-IP rate-limited by design.
  Its **official web service** remains the most interesting *production* route if commercially accessible.

## 10. Next engineering decisions (not implemented)

1. **Where the integration runs.** MrBilit worked from a German home network. FlyToday's API host did not. Decide
   whether production may run outside Iran at all. Using a third-party proxy to defeat a regional block is a
   legal/ToS decision, not a technical default.
2. **Licensing path.** Commercial license for the MCP servers, or official provider APIs (FlyToday web service,
   MrBilit partnership), or a non-commercial R&D-only scope for now.
3. **Integration boundary.** Keep MCP as a subprocess adapter (fast to try, but Python + uv at runtime and
   unofficial endpoints) or write provider adapters against official APIs behind the same `NormalizedFlight`/`NormalizedHotel` contract.
4. **Freshness policy.** How old a price may be before it's shown, and mandatory re-search before any action,
   given ids that expire.
5. **Rate-limit and caching budget** per provider and per user, given FlyToday's per-IP limits.
6. **Raw-response retention:** how long, where, and what to redact once real data flows.
