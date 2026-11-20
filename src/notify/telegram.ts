/**
 * Minimal client for the official Telegram Bot API (https://core.telegram.org/bots/api), only what PEYVA needs:
 * getMe, getUpdates (to verify a link), sendMessage. The bot token is part of the request URL, so no URL and no raw
 * error that could contain it is ever returned or logged.
 */
export type SendOutcome =
  | { kind: "sent"; messageId: number }
  | { kind: "retryable"; reason: string; retryAfterSec?: number }   // not delivered (no response, 429, 5xx)
  | { kind: "ambiguous"; reason: string }                            // request may have reached Telegram (timeout after sending)
  | { kind: "permanent"; reason: string };                           // 4xx: chat not found, bot blocked, bad token

export interface TelegramUpdate { update_id: number; message?: { text?: string; chat: { id: number; type: string }; from?: { id: number } } }

export class TelegramClient {
  constructor(private token: string, private baseUrl = "https://api.telegram.org", private timeoutMs = 10_000) {
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error("TELEGRAM_BOT_TOKEN has an invalid format");
  }

  private scrub(s: string) { return s.split(this.token).join("***"); }

  private async call(method: string, body: Record<string, unknown>): Promise<{ status: number; json: any } | { error: "network" | "timeout"; message: string }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    } catch (e) {
      const msg = this.scrub((e as Error).message ?? String(e));
      return ctrl.signal.aborted ? { error: "timeout", message: msg } : { error: "network", message: msg };
    } finally { clearTimeout(t); }
  }

  async getMe(): Promise<{ username: string } | null> {
    const r = await this.call("getMe", {});
    return "status" in r && r.json?.ok ? { username: r.json.result.username } : null;
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[] | null> {
    const r = await this.call("getUpdates", { offset, timeout: 0, allowed_updates: ["message"] });
    return "status" in r && r.json?.ok && Array.isArray(r.json.result) ? r.json.result : null;
  }

  async sendMessage(chatId: number, text: string): Promise<SendOutcome> {
    const r = await this.call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
    if ("error" in r) return r.error === "timeout" ? { kind: "ambiguous", reason: "timeout after sending" } : { kind: "retryable", reason: `network: ${r.message.slice(0, 120)}` };
    if (r.status === 200 && r.json?.ok) return { kind: "sent", messageId: r.json.result?.message_id ?? 0 };
    const desc = this.scrub(String(r.json?.description ?? `HTTP ${r.status}`)).slice(0, 160);
    if (r.status === 429) return { kind: "retryable", reason: desc, retryAfterSec: r.json?.parameters?.retry_after };
    if (r.status >= 500) return { kind: "retryable", reason: desc };
    return { kind: "permanent", reason: desc };
  }
}

export function telegramFromEnv(env: Record<string, string | undefined> = process.env): TelegramClient | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  return new TelegramClient(token, env.TELEGRAM_API_BASE_URL?.trim() || "https://api.telegram.org");
}
