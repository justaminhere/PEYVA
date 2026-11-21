/**
 * Notifications (Phase 3): a database outbox. A match always creates a persisted in-app notification; if the user has
 * linked Telegram (verified bot interaction), a Telegram row is queued too and delivered by the worker.
 * - Dedup: one row per (goal, result key, price, channel), enforced by a unique index.
 * - Re-alert only if the price improved by >= improvementPct, or a different option appears after the cooldown.
 * - "sent" is written only after Telegram confirms. Ambiguous failures are retried once, then marked "unknown"
 *   (the message may or may not have arrived; a duplicate on the user's phone is possible).
 */
import { tehranDateTime } from "../agent/confirm.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { appState, notifications, telegramLinkCodes, telegramLinks } from "../db/schema.ts";
import type { Goal } from "../goals/service.ts";
import type { ExecutionMatch } from "../goals/types.ts";
import type { TelegramClient } from "./telegram.ts";
import { formatJalaliFa } from "../goal/dates.ts";
import { formatToman, toPersianDigits } from "../goal/persian.ts";
import { cleanText } from "../agent/untrusted.ts";

export interface NotifyOptions { cooldownMs?: number; improvementPct?: number; maxAttempts?: number; now?: () => Date }

const tehran = (iso: string) => tehranDateTime(new Date(iso));

interface FlightInfo { flightNumbers?: string[]; airline?: string | null; departureTime?: string | null }
interface MatchDetails { departure: string; return: string; nights: number; hotel?: { name?: string; stars?: number } | null; outboundFlight?: FlightInfo | null; returnFlight?: FlightInfo | null }

const flightNo = (f: FlightInfo | null | undefined) => (f?.flightNumbers?.length ? f.flightNumbers.map((x) => cleanText(x, 12)).join(" + ") : "؟");
const clock = (iso: string | null | undefined) => (iso && /T(\d\d:\d\d)/.test(iso) ? toPersianDigits(iso.match(/T(\d\d:\d\d)/)![1]!) : null);
const flightLine = (label: string, f: FlightInfo | null | undefined) =>
  f ? `${label}: ${f.airline ? cleanText(f.airline, 30) + " " : ""}${flightNo(f)}${clock(f.departureTime) ? ` · ساعت ${clock(f.departureTime)}` : ""}` : null;

/**
 * What identifies "the same trip" for alerting: the departure date and the flight numbers of both legs.
 * Provider fare ids are deliberately NOT used: they can change between searches while the flight stays the same.
 */
export function flightSignature(details: unknown): string | null {
  const d = details as Partial<MatchDetails> | null | undefined;
  if (!d?.departure) return null;
  return [d.departure, d.outboundFlight?.flightNumbers?.join("+") ?? "", d.returnFlight?.flightNumbers?.join("+") ?? ""].join("|");
}

/** Human description of a flight change between two alerts, or null if the flights are the same. */
export function describeFlightChange(prev: unknown, next: unknown): string | null {
  const a = prev as Partial<MatchDetails> | null | undefined, b = next as Partial<MatchDetails> | null | undefined;
  if (!a || !b || flightSignature(a) === flightSignature(b)) return null;
  const parts: string[] = [];
  if (a.departure !== b.departure && a.departure && b.departure) parts.push(`تاریخ رفت: قبلاً ${formatJalaliFa(a.departure)}، حالا ${formatJalaliFa(b.departure)}`);
  if (flightNo(a.outboundFlight) !== flightNo(b.outboundFlight)) parts.push(`پرواز رفت: قبلاً ${flightNo(a.outboundFlight)}، حالا ${flightNo(b.outboundFlight)}`);
  if (flightNo(a.returnFlight) !== flightNo(b.returnFlight)) parts.push(`پرواز برگشت: قبلاً ${flightNo(a.returnFlight)}، حالا ${flightNo(b.returnFlight)}`);
  return parts.length ? parts.join("\n") : null;
}

export function formatMatchFa(goal: Pick<Goal, "id" | "name">, m: ExecutionMatch, change: { flights?: string | null; previousTotal?: number | null } = {}): string {
  const d = m.details as unknown as MatchDetails;
  const delta = change.previousTotal && change.previousTotal !== m.totalToman
    ? ` (${m.totalToman < change.previousTotal ? "ارزان‌تر" : "گران‌تر"} از اعلان قبلی: ${formatToman(change.previousTotal)} تومان)` : "";
  return [
    change.flights ? `🔔 پیوا: پرواز گزینهٔ پیشنهادی عوض شد` : `🔔 پیوا: گزینه‌ای در بودجه‌ات پیدا شد`,
    `هدف: ${cleanText(goal.name, 80)} (#${toPersianDigits(goal.id)})`,
    change.flights ? `تغییر نسبت به اعلان قبلی:\n${change.flights}` : null,
    `تاریخ: ${formatJalaliFa(d.departure)} تا ${formatJalaliFa(d.return)}`,
    flightLine("پرواز رفت", d.outboundFlight),
    flightLine("پرواز برگشت", d.returnFlight),
    d.hotel?.name ? `هتل: ${cleanText(d.hotel.name, 50)}${d.hotel.stars ? ` (${toPersianDigits(d.hotel.stars)} ستاره)` : ""}` : null,
    `جمع مشاهده‌شده: ${formatToman(m.totalToman)} تومان${delta}`,
    `منبع: ${m.provider} · بررسی: ${tehran(m.checkedAt)} (تهران)`,
    `قیمت و ظرفیت ممکن است تغییر کند؛ این رزرو نیست.`,
  ].filter(Boolean).join("\n");
}

export class NotificationService {
  private cooldownMs: number; private improvementPct: number; private maxAttempts: number; private now: () => Date;
  constructor(private db: Db, private telegram: TelegramClient | null, o: NotifyOptions = {}) {
    this.cooldownMs = o.cooldownMs ?? 24 * 3_600_000;
    this.improvementPct = o.improvementPct ?? 5;
    this.maxAttempts = o.maxAttempts ?? 5;
    this.now = o.now ?? (() => new Date());
  }

  /** Decide whether a match is worth an alert and queue it. Never sends anything itself. */
  async queueMatch(goal: Goal, m: ExecutionMatch): Promise<{ queued: boolean; reason: string; channels: string[] }> {
    const now = this.now();
    const [last] = await this.db.select().from(notifications)
      .where(and(eq(notifications.goalId, goal.id), eq(notifications.type, "match_found"), eq(notifications.channel, "in_app")))
      .orderBy(desc(notifications.createdAt)).limit(1);
    const prev = last?.payload as { key?: string; totalToman?: number; details?: unknown } | undefined;
    const flightChange = last ? describeFlightChange(prev?.details, m.details) : null;
    let why: string | null = null;
    if (!last) why = "first match";
    else if (prev?.key === m.key && prev?.totalToman === m.totalToman) return { queued: false, reason: "unchanged result", channels: [] };
    // The user's rule: a different flight (number or date) is always worth telling, even within the cooldown,
    // because the flight they were told about may be gone. Checks run at most every 6 h, which bounds the volume.
    else if (flightChange) why = "flight changed";
    else if (prev?.totalToman && m.totalToman <= prev.totalToman * (1 - this.improvementPct / 100)) why = `price improved ≥ ${this.improvementPct}%`;
    else if (now.getTime() - last.createdAt.getTime() >= this.cooldownMs && prev?.key !== m.key) why = "different option after cooldown";
    if (!why) return { queued: false, reason: "within cooldown / no meaningful improvement", channels: [] };

    const text = formatMatchFa(goal, m, { flights: flightChange, previousTotal: prev?.totalToman ?? null });
    const payload = { key: m.key, totalToman: m.totalToman, provider: m.provider, checkedAt: m.checkedAt, text, details: m.details };
    // Same result after the same previous alert = the same alert (protects against double processing), but A -> B -> A
    // is a real change for the user, who was last told about B, so it alerts again.
    const dedup = (ch: string) => `match:${goal.id}:${m.key}:${m.totalToman}:after:${last?.id ?? 0}:${ch}`;
    const channels: string[] = [];
    const inApp = await this.db.insert(notifications).values({ userId: goal.userId, goalId: goal.id, type: "match_found", channel: "in_app", payload,
      deliveryStatus: "stored", deduplicationKey: dedup("in_app"), createdAt: now }).onConflictDoNothing().returning({ id: notifications.id });
    if (inApp.length) channels.push("in_app");
    const [link] = await this.db.select().from(telegramLinks).where(eq(telegramLinks.userId, goal.userId));
    if (link) {
      const tg = await this.db.insert(notifications).values({ userId: goal.userId, goalId: goal.id, type: "match_found", channel: "telegram", payload,
        deliveryStatus: "pending", deduplicationKey: dedup("telegram"), nextAttemptAt: now, createdAt: now }).onConflictDoNothing().returning({ id: notifications.id });
      if (tg.length) channels.push("telegram");
    }
    return { queued: channels.length > 0, reason: channels.length ? why : "duplicate (already queued)", channels };
  }

  /** Deliver due Telegram rows. Rows are claimed with SKIP LOCKED so two workers never send the same row. */
  async deliverPending(limit = 10) {
    const now = this.now();
    const out: { id: number; status: string; reason?: string }[] = [];
    // A row stuck in "sending" (worker crashed mid-send) may or may not have reached Telegram: mark it unknown, don't resend.
    await this.db.update(notifications).set({ deliveryStatus: "unknown", lastError: "worker stopped while sending" })
      .where(and(eq(notifications.channel, "telegram"), eq(notifications.deliveryStatus, "sending"), lte(notifications.nextAttemptAt, new Date(now.getTime() - 10 * 60_000))));
    if (!this.telegram) return out;
    const claimed = await this.db.execute<{ id: number }>(sql`
      update notifications set delivery_status = 'sending', next_attempt_at = ${now.toISOString()}::timestamptz
      where id in (select id from notifications where channel = 'telegram' and delivery_status in ('pending','retrying')
                   and next_attempt_at <= ${now.toISOString()}::timestamptz order by id limit ${limit} for update skip locked)
      returning id`);
    for (const { id } of claimed) {
      const [row] = await this.db.select().from(notifications).where(eq(notifications.id, Number(id)));
      if (!row) continue;
      const [link] = await this.db.select().from(telegramLinks).where(eq(telegramLinks.userId, row.userId));
      const attempts = row.attempts + 1;
      if (!link) { await this.finish(row.id, { deliveryStatus: "failed", attempts, lastError: "telegram no longer linked" }); out.push({ id: row.id, status: "failed" }); continue; }
      const r = await this.telegram.sendMessage(link.chatId, (row.payload as { text: string }).text);
      if (r.kind === "sent") { await this.finish(row.id, { deliveryStatus: "sent", attempts, deliveredAt: this.now(), lastError: null }); out.push({ id: row.id, status: "sent" }); }
      else if (r.kind === "permanent") { await this.finish(row.id, { deliveryStatus: "failed", attempts, lastError: r.reason }); out.push({ id: row.id, status: "failed", reason: r.reason }); }
      else if (r.kind === "ambiguous" && attempts >= 2) { await this.finish(row.id, { deliveryStatus: "unknown", attempts, lastError: r.reason }); out.push({ id: row.id, status: "unknown", reason: r.reason }); }
      else if (attempts >= this.maxAttempts) { await this.finish(row.id, { deliveryStatus: "failed", attempts, lastError: `gave up: ${r.reason}` }); out.push({ id: row.id, status: "failed", reason: r.reason }); }
      else {
        const waitMs = "retryAfterSec" in r && r.retryAfterSec ? r.retryAfterSec * 1000 : 60_000 * 2 ** (attempts - 1);
        await this.finish(row.id, { deliveryStatus: "retrying", attempts, lastError: r.reason, nextAttemptAt: new Date(now.getTime() + waitMs) });
        out.push({ id: row.id, status: "retrying", reason: r.reason });
      }
    }
    return out;
  }

  private finish(id: number, set: Partial<typeof notifications.$inferInsert>) {
    return this.db.update(notifications).set(set).where(and(eq(notifications.id, id), eq(notifications.deliveryStatus, "sending")));
  }

  /**
   * Explicit, user-requested live test of the whole Telegram path (outbox → Bot API → stored status).
   * Returns the row as stored afterwards: "sent" only if Telegram answered ok.
   */
  async sendTest(userId: string): Promise<{ ok: false; reason: string } | { ok: true; row: typeof notifications.$inferSelect }> {
    if (!this.telegram) return { ok: false, reason: "TELEGRAM_BOT_TOKEN is not set" };
    const [link] = await this.db.select().from(telegramLinks).where(eq(telegramLinks.userId, userId));
    if (!link) return { ok: false, reason: "Telegram is not linked (/telegram link, then /telegram verify)" };
    const now = this.now();
    const text = `🧪 پیوا: پیام آزمایشی اعلان‌ها\nاگر این را می‌بینی، مسیر اعلان تلگرام کار می‌کند.\nزمان: ${tehranDateTime(now)} (تهران)`;
    const [row] = await this.db.insert(notifications).values({ userId, goalId: null, type: "test", channel: "telegram", payload: { text },
      deliveryStatus: "pending", deduplicationKey: `test:${userId}:${now.getTime()}:${randomUUID()}`, nextAttemptAt: now, createdAt: now }).returning();
    await this.deliverPending();
    const [after] = await this.db.select().from(notifications).where(eq(notifications.id, row!.id));
    return { ok: true, row: after! };
  }

  /** Latest in-app match alert of a goal and the stored status of its Telegram copy (same alert, other channel). */
  async latestForGoal(userId: string, goalId: number) {
    const [inApp] = await this.db.select().from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.goalId, goalId), eq(notifications.channel, "in_app"))).orderBy(desc(notifications.id)).limit(1);
    if (!inApp) return null;
    const [telegram] = await this.db.select().from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.deduplicationKey, inApp.deduplicationKey.replace(/:in_app$/, ":telegram")))).limit(1);
    return { inApp, telegram: telegram ?? null };
  }

  async unreadCount(userId: string): Promise<number> {
    const rows = await this.db.select({ id: notifications.id }).from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.channel, "in_app"), eq(notifications.deliveryStatus, "stored")));
    return rows.length;
  }

  list(userId: string, limit = 20) {
    return this.db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(limit);
  }

  async markRead(userId: string) {
    await this.db.update(notifications).set({ deliveryStatus: "read" })
      .where(and(eq(notifications.userId, userId), eq(notifications.channel, "in_app"), eq(notifications.deliveryStatus, "stored")));
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Telegram opt-in. The user gets a one-time code and sends "/start <code>" to the bot from their own Telegram.
 * Only a chat that delivered a valid, unexpired, unused code of THIS user is linked. A typed chat id is never accepted.
 */
export class TelegramLinker {
  constructor(private db: Db, private telegram: TelegramClient, private now: () => Date = () => new Date()) {}

  async createCode(userId: string, ttlMs = 15 * 60_000) {
    const code = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8);
    await this.db.insert(telegramLinkCodes).values({ userId, codeHash: sha(code), expiresAt: new Date(this.now().getTime() + ttlMs) });
    const me = await this.telegram.getMe();
    return { code, botUsername: me?.username ?? null, deepLink: me ? `https://t.me/${me.username}?start=${code}` : null };
  }

  async verify(userId: string): Promise<{ linked: boolean; reason: string }> {
    const [st] = await this.db.select().from(appState).where(eq(appState.key, "telegram_update_offset"));
    const offset = Number((st?.value as { offset?: number } | undefined)?.offset ?? 0);
    const updates = await this.telegram.getUpdates(offset);
    if (!updates) return { linked: false, reason: "could not read updates from Telegram" };
    let linked = false;
    let maxId = offset - 1;
    for (const u of updates) {
      maxId = Math.max(maxId, u.update_id);
      const m = u.message;
      const code = m?.text?.match(/^\/start\s+([A-Za-z0-9]{8})$/)?.[1];
      if (!m || !code || m.chat.type !== "private") continue;
      const [row] = await this.db.select().from(telegramLinkCodes).where(and(eq(telegramLinkCodes.userId, userId), eq(telegramLinkCodes.codeHash, sha(code)),
        isNull(telegramLinkCodes.usedAt), gt(telegramLinkCodes.expiresAt, this.now())));
      if (!row) continue;
      await this.db.update(telegramLinkCodes).set({ usedAt: this.now() }).where(eq(telegramLinkCodes.id, row.id));
      await this.db.insert(telegramLinks).values({ userId, chatId: m.chat.id, verifiedAt: this.now() })
        .onConflictDoUpdate({ target: telegramLinks.userId, set: { chatId: m.chat.id, verifiedAt: this.now() } });
      await this.telegram.sendMessage(m.chat.id, "✅ این چت به پیوا وصل شد. هشدارهای پیگیری قیمت اینجا فرستاده می‌شوند.");
      linked = true;
    }
    await this.db.insert(appState).values({ key: "telegram_update_offset", value: { offset: maxId + 1 } })
      .onConflictDoUpdate({ target: appState.key, set: { value: { offset: maxId + 1 }, updatedAt: this.now() } });
    return linked ? { linked: true, reason: "linked" } : { linked: false, reason: "no valid code received yet" };
  }

  async unlink(userId: string) {
    await this.db.delete(telegramLinks).where(eq(telegramLinks.userId, userId));
  }

  async status(userId: string) {
    const [l] = await this.db.select().from(telegramLinks).where(eq(telegramLinks.userId, userId));
    return l ? { linked: true, verifiedAt: l.verifiedAt } : { linked: false };
  }
}
