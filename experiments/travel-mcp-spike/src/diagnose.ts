import type { CallOutcome } from "./mcp.ts";

export type FailureCause =
  | "invalid_query"
  | "network_or_geo_block"
  | "timeout"
  | "rate_limit"
  | "anti_bot_challenge"
  | "schema_or_argument"
  | "upstream_api_change"
  | "process_or_install"
  | "unknown";

/** Heuristic classification from the upstream servers' documented error texts. */
export function diagnose(o: CallOutcome): FailureCause | null {
  if (o.kind === "ok") return null;
  if (o.kind === "timeout") return "timeout";
  if (o.kind === "transport_error") return "process_or_install";
  const m = o.message;
  if (/captcha|\b429\b|rate.?limit/i.test(m)) return "rate_limit";
  if (/bot.?check|challenge/i.test(m)) return "anti_bot_challenge";
  if (/Could not reach|ConnectError|ConnectTimeout|resets connections|outside Iran|ProxyError|\b403\b/i.test(m))
    return "network_or_geo_block";
  if (/did not answer in time|timed? ?out/i.test(m)) return "timeout";
  if (/validation error|Input validation|Invalid arguments|Unknown tool|required/i.test(m)) return "schema_or_argument";
  if (/KeyError|unexpected|JSONDecodeError|TypeError/i.test(m)) return "upstream_api_change";
  return "unknown";
}
