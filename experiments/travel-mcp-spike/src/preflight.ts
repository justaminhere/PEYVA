import { connect } from "node:tls";
import { lookup } from "node:dns/promises";
import type { ProviderId } from "./providers.ts";

/**
 * Backend hosts each server calls (read from the pinned upstream sources:
 * mrbilit_mcp/http.py and flytoday_mcp/http.py). Re-check when bumping versions.
 */
export const PROVIDER_HOSTS: Record<ProviderId, string[]> = {
  mrbilit: ["flight.atighgasht.com", "hotel.mrbilit.ir"],
  flytoday: ["www.flytoday.ir", "api.flytoday.ir", "placesearch.flytoday.ir"],
};

export interface HostCheck {
  host: string;
  dns: "ok" | "fail";
  tls: "ok" | "fail" | "skipped";
  ms: number;
  error: string | null;
}

/**
 * Like the servers, this connects DIRECTLY (they ignore HTTPS_PROXY on purpose): DNS, TCP, TLS handshake.
 * No HTTP request is sent, so it costs the provider nothing and does not count against rate limits.
 */
export async function checkHost(host: string, timeoutMs = 8_000): Promise<HostCheck> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  try {
    await lookup(host);
  } catch (e) {
    return { host, dns: "fail", tls: "skipped", ms: ms(), error: (e as Error).message };
  }
  return new Promise((resolve) => {
    const sock = connect({ host, port: 443, servername: host, timeout: timeoutMs });
    const done = (r: Omit<HostCheck, "host" | "dns" | "ms">) => { sock.destroy(); resolve({ host, dns: "ok", ms: ms(), ...r }); };
    sock.once("secureConnect", () => done({ tls: "ok", error: null }));
    sock.once("timeout", () => done({ tls: "fail", error: `timeout after ${timeoutMs} ms` }));
    sock.once("error", (e) => done({ tls: "fail", error: e.message }));
  });
}

export async function preflight(id: ProviderId) {
  const checks = await Promise.all(PROVIDER_HOSTS[id].map((h) => checkHost(h)));
  return { provider: id, reachable: checks.every((c) => c.tls === "ok"), checks };
}
