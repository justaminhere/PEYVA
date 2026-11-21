/**
 * Public MVP mode (PEYVA_PUBLIC=1): anyone with the link can use PEYVA, each visitor in their own space.
 *
 * - Identity: an anonymous, random visitor id in a signed HttpOnly cookie. No accounts, no personal data. All rows
 *   (goals, memory, conversations, alerts) are scoped by that id exactly like the single local user was.
 * - Sessions: one serialized agent session per visitor, kept in memory while used and resumed from PostgreSQL after
 *   eviction or a restart.
 * - Quotas: the LLM key and the travel provider are shared by everyone, so turns, searches, new visitors and tokens
 *   are capped per day, and LLM turns run at most `maxConcurrentTurns` at a time.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { toPersianDigits } from "../goal/persian.ts";
import { AgentHost } from "./host.ts";
import type { Visitor, WebLimits } from "./app.ts";

export const COOKIE = "peyva_v";
const ID_RE = /^v_[A-Za-z0-9_-]{22}$/;

/** Signs and checks visitor ids (HMAC-SHA256, key = PEYVA_SESSION_SECRET). */
export class VisitorIds {
  constructor(private secret: string) {
    if (secret.length < 32) throw new Error("PEYVA_SESSION_SECRET must be at least 32 characters");
  }
  private mac(id: string) { return createHmac("sha256", this.secret).update(id).digest("base64url"); }
  newId() { return `v_${randomBytes(16).toString("base64url")}`; }
  sign(id: string) { return `${id}.${this.mac(id)}`; }
  /** The id inside a cookie value, or null when it is missing, malformed or not signed by this server. */
  verify(value: string | undefined): string | null {
    if (!value) return null;
    const dot = value.lastIndexOf(".");
    const id = value.slice(0, dot), sig = value.slice(dot + 1);
    if (dot < 0 || !ID_RE.test(id)) return null;
    const want = Buffer.from(this.mac(id)), got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got) ? id : null;
  }
}

/** Counts per key and UTC day, in memory (a restart resets them; acceptable for a small MVP). */
export class DailyCounter {
  private m = new Map<string, number>();
  private day = "";
  constructor(private now: () => Date = () => new Date()) {}
  private roll() {
    const d = this.now().toISOString().slice(0, 10);
    if (d !== this.day) { this.day = d; this.m.clear(); }
  }
  get(key: string) { this.roll(); return this.m.get(key) ?? 0; }
  add(key: string, n = 1) { this.roll(); this.m.set(key, this.get(key) + n); }
}

export interface QuotaOptions {
  turnsPerVisitorPerDay: number;
  searchesPerVisitorPerDay: number;
  /** Whole-site LLM tokens per UTC day; keep it under the provider's own daily limit. */
  tokensPerDay: number;
  maxConcurrentTurns: number;
  newVisitorsPerIpPerDay: number;
  maxActiveGoalsPerVisitor: number;
  maxActiveGoalsTotal: number;
}

export const DEFAULT_QUOTAS: QuotaOptions = {
  turnsPerVisitorPerDay: 25, searchesPerVisitorPerDay: 10, tokensPerDay: 150_000, maxConcurrentTurns: 2,
  newVisitorsPerIpPerDay: 5, maxActiveGoalsPerVisitor: 2, maxActiveGoalsTotal: 40,
};

const fa = (n: number) => toPersianDigits(n);

export function quotasFromEnv(env: Record<string, string | undefined> = process.env): QuotaOptions {
  const n = (k: string, d: number) => { const v = Number(env[k]); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : d; };
  return {
    turnsPerVisitorPerDay: n("PEYVA_PUBLIC_TURNS_PER_DAY", DEFAULT_QUOTAS.turnsPerVisitorPerDay),
    searchesPerVisitorPerDay: n("PEYVA_PUBLIC_SEARCHES_PER_DAY", DEFAULT_QUOTAS.searchesPerVisitorPerDay),
    tokensPerDay: n("PEYVA_PUBLIC_TOKENS_PER_DAY", DEFAULT_QUOTAS.tokensPerDay),
    maxConcurrentTurns: Math.max(1, n("PEYVA_PUBLIC_CONCURRENT_TURNS", DEFAULT_QUOTAS.maxConcurrentTurns)),
    newVisitorsPerIpPerDay: n("PEYVA_PUBLIC_NEW_VISITORS_PER_IP", DEFAULT_QUOTAS.newVisitorsPerIpPerDay),
    maxActiveGoalsPerVisitor: n("PEYVA_PUBLIC_GOALS_PER_VISITOR", DEFAULT_QUOTAS.maxActiveGoalsPerVisitor),
    maxActiveGoalsTotal: n("PEYVA_PUBLIC_GOALS_TOTAL", DEFAULT_QUOTAS.maxActiveGoalsTotal),
  };
}

/** The per-visitor and whole-site quotas behind WebLimits. */
export class Quotas implements WebLimits {
  private counts: DailyCounter;
  private running = 0;
  constructor(readonly o: QuotaOptions, now: () => Date = () => new Date()) { this.counts = new DailyCounter(now); }

  get summaryFa() {
    return `نسخهٔ آزمایشی عمومی: روزانه ${fa(this.o.turnsPerVisitorPerDay)} پیام و ${fa(this.o.searchesPerVisitorPerDay)} جست‌وجوی دستی برای هر بازدیدکننده، `
      + `حداکثر ${fa(this.o.maxActiveGoalsPerVisitor)} پیگیری فعال. اطلاعات شخصی (نام، تلفن، کد ملی) وارد نکن.`;
  }
  tokensUsedToday() { return this.counts.get("tokens"); }

  beginTurn(userId: string): ReturnType<WebLimits["beginTurn"]> {
    if (this.counts.get(`turn:${userId}`) >= this.o.turnsPerVisitorPerDay)
      return { ok: false, status: 429, errorFa: `سهم امروزت (${fa(this.o.turnsPerVisitorPerDay)} پیام) تمام شد؛ فردا دوباره امتحان کن. ویرایش خلاصهٔ سفر و پیگیری‌ها همچنان کار می‌کنند.` };
    if (this.counts.get("tokens") >= this.o.tokensPerDay)
      return { ok: false, status: 429, errorFa: "سهمیهٔ روزانهٔ مدل زبانی برای کل این نسخهٔ آزمایشی تمام شده؛ فردا دوباره امتحان کن. ویرایش خلاصهٔ سفر و دکمهٔ جست‌وجو هنوز کار می‌کنند." };
    if (this.running >= this.o.maxConcurrentTurns)
      return { ok: false, status: 503, errorFa: "پیوا الان با چند نفر دیگر مشغول است؛ چند ثانیه بعد دوباره بفرست." };
    this.running++;
    this.counts.add(`turn:${userId}`);
    let done = false;
    return { ok: true, done: (tokens) => {
      if (done) return;
      done = true;
      this.running--;
      if (tokens > 0) this.counts.add("tokens", tokens);
    } };
  }

  beginSearch(userId: string): ReturnType<WebLimits["beginSearch"]> {
    if (this.counts.get(`search:${userId}`) >= this.o.searchesPerVisitorPerDay)
      return { ok: false, status: 429, errorFa: `سهم امروزت برای جست‌وجوی دستی (${fa(this.o.searchesPerVisitorPerDay)} بار) تمام شد؛ فردا دوباره امتحان کن.` };
    this.counts.add(`search:${userId}`);
    return { ok: true };
  }

  /** A new visitor id from this IP: allowed `newVisitorsPerIpPerDay` times a day (cookie-clearing loops). */
  allowNewVisitor(ip: string) {
    if (this.counts.get(`new:${ip}`) >= this.o.newVisitorsPerIpPerDay) return false;
    this.counts.add(`new:${ip}`);
    return true;
  }
}

/** In-memory agent sessions by visitor: least recently used first out; a dropped one resumes from PostgreSQL. */
export class VisitorPool {
  private m = new Map<string, { host: AgentHost; last: number }>();
  constructor(private make: (userId: string) => AgentHost, private max = 200, private idleMs = 30 * 60_000, private now = () => Date.now()) {}
  get size() { return this.m.size; }
  get(userId: string): AgentHost {
    const t = this.now();
    for (const [k, e] of this.m) if (t - e.last > this.idleMs) this.m.delete(k);
    let e = this.m.get(userId);
    if (e) this.m.delete(userId); // re-insert: Map order = recency
    else e = { host: this.make(userId), last: t };
    e.last = t;
    this.m.set(userId, e);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
    return e.host;
  }
}

/**
 * The client's address as the platform's proxy saw it: the last entry of `header` (default X-Forwarded-For).
 * Earlier entries can be sent by the client itself, so only the one the proxy appended is trusted.
 */
export function clientIp(c: Context, header = "x-forwarded-for") {
  const v = c.req.header(header) ?? "";
  return v.split(",").map((x) => x.trim()).filter(Boolean).pop() ?? "unknown";
}

export interface PublicVisitorDeps {
  ids: VisitorIds;
  pool: VisitorPool;
  quotas: Quotas;
  /** Builds the visitor's services (same services, scoped to their id) and makes sure the user row exists. */
  ctxFor: (userId: string) => Promise<Visitor["ctx"]>;
  secureCookie: boolean;
  ipHeader?: string;
  maxAgeDays?: number;
}

/** WebDeps.visitor for public mode: reads (or issues) the signed visitor cookie. */
export function publicVisitor(d: PublicVisitorDeps) {
  return async (c: Context): Promise<Visitor | Response> => {
    let id = d.ids.verify(getCookie(c, COOKIE));
    if (!id) {
      // A new id per request without a valid cookie; one address may create only a few per day (cookie-clearing loops).
      if (!d.quotas.allowNewVisitor(clientIp(c, d.ipHeader)))
        return c.json({ errorFa: "از این شبکه امروز بازدیدکنندهٔ تازهٔ زیادی ساخته شده؛ فردا دوباره امتحان کن." }, 429);
      id = d.ids.newId();
      setCookie(c, COOKIE, d.ids.sign(id), { httpOnly: true, secure: d.secureCookie, sameSite: "Lax", path: "/", maxAge: (d.maxAgeDays ?? 30) * 86_400 });
    }
    const ctx = await d.ctxFor(id); // creates the user row first: a new session inserts a conversation row for it
    return { host: d.pool.get(id), ctx };
  };
}
