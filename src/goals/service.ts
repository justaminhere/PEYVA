/**
 * Goal lifecycle. Every state change is a database operation first; callers (and the LLM) report only what the
 * returned persisted row says. All operations are scoped by userId: another user's goal reads as "not found".
 *
 *   draft --approve(shown hash)--> active --pause--> paused --resume--> active
 *   any non-final --cancel--> canceled;  active/paused/draft --expire (worker)--> expired
 *   active/paused --updateConstraints--> draft (monitoring stops until the new conditions are approved)
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lte, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { goalChecks, goals, type GoalStatus } from "../db/schema.ts";
import type { ExecutorRegistry } from "./types.ts";

export type Goal = typeof goals.$inferSelect;
export type Fail = { ok: false; reason: "not_found" | "invalid_constraints" | "unknown_type" | "wrong_state" | "stale_approval" | "expired"; detail?: string };

/** Stable JSON (sorted keys) so that the same constraints always give the same hash. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const constraintsHash = (c: unknown) => createHash("sha256").update(canonical(c)).digest("hex").slice(0, 16);

const FINAL: GoalStatus[] = ["canceled", "expired"];

export class GoalService {
  constructor(private db: Db, private registry: ExecutorRegistry) {}

  private validate(type: string, raw: unknown) {
    const ex = this.registry.get(type);
    if (!ex) return { ok: false as const, reason: "unknown_type" as const };
    const r = ex.schema.safeParse(raw);
    if (!r.success) return { ok: false as const, reason: "invalid_constraints" as const, detail: r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    return { ok: true as const, ex, c: r.data };
  }

  async createDraft(userId: string, type: string, raw: unknown, now = new Date()): Promise<{ ok: true; goal: Goal; summaryFa: string } | Fail> {
    const v = this.validate(type, raw);
    if (!v.ok) return v;
    const expiresAt = v.ex.expiresAt(v.c);
    if (expiresAt <= now) return { ok: false, reason: "expired", detail: "all dates are in the past" };
    const [goal] = await this.db.insert(goals).values({
      userId, type, name: v.ex.nameFa(v.c), structuredConstraints: v.c as object, constraintsHash: constraintsHash(v.c),
      status: "draft", expiresAt, createdAt: now, updatedAt: now,
    }).returning();
    return { ok: true, goal: goal!, summaryFa: v.ex.describeFa(v.c) };
  }

  /** Approve exactly the conditions the user was shown (by hash). */
  async approve(userId: string, goalId: number, shownHash: string, now = new Date()): Promise<{ ok: true; goal: Goal } | Fail> {
    const g = await this.get(userId, goalId);
    if (!g) return { ok: false, reason: "not_found" };
    if (g.status !== "draft") return { ok: false, reason: "wrong_state", detail: g.status };
    if (g.constraintsHash !== shownHash) return { ok: false, reason: "stale_approval" };
    if (g.expiresAt <= now) return { ok: false, reason: "expired" };
    const [row] = await this.db.update(goals).set({ status: "active", approvedAt: now, approvedConstraintsHash: g.constraintsHash, nextCheckAt: now,
      consecutiveFailures: 0, updatedAt: now })
      .where(and(eq(goals.id, goalId), eq(goals.userId, userId), eq(goals.status, "draft"), eq(goals.constraintsHash, shownHash))).returning();
    return row ? { ok: true, goal: row } : { ok: false, reason: "wrong_state" };
  }

  /** A material edit: new constraints go back to draft and need a new approval; monitoring stops meanwhile. */
  async updateConstraints(userId: string, goalId: number, raw: unknown, now = new Date()): Promise<{ ok: true; goal: Goal; summaryFa: string; changed: boolean } | Fail> {
    const g = await this.get(userId, goalId);
    if (!g) return { ok: false, reason: "not_found" };
    if (FINAL.includes(g.status)) return { ok: false, reason: "wrong_state", detail: g.status };
    const v = this.validate(g.type, raw);
    if (!v.ok) return v;
    const hash = constraintsHash(v.c);
    if (hash === g.constraintsHash) return { ok: true, goal: g, summaryFa: v.ex.describeFa(v.c), changed: false };
    const [row] = await this.db.update(goals).set({ structuredConstraints: v.c as object, constraintsHash: hash, name: v.ex.nameFa(v.c), status: "draft",
      approvedAt: null, approvedConstraintsHash: null, nextCheckAt: null, expiresAt: v.ex.expiresAt(v.c), updatedAt: now })
      .where(and(eq(goals.id, goalId), eq(goals.userId, userId))).returning();
    return { ok: true, goal: row!, summaryFa: v.ex.describeFa(v.c), changed: true };
  }

  private async transition(userId: string, goalId: number, from: GoalStatus[], set: Partial<typeof goals.$inferInsert>, now: Date) {
    const [row] = await this.db.update(goals).set({ ...set, updatedAt: now })
      .where(and(eq(goals.id, goalId), eq(goals.userId, userId), inArray(goals.status, from))).returning();
    if (row) return { ok: true as const, goal: row };
    const g = await this.get(userId, goalId);
    return g ? { ok: false as const, reason: "wrong_state" as const, detail: g.status } : { ok: false as const, reason: "not_found" as const };
  }

  pause(userId: string, goalId: number, now = new Date()) { return this.transition(userId, goalId, ["active"], { status: "paused" }, now); }
  async resume(userId: string, goalId: number, now = new Date()) {
    const g = await this.get(userId, goalId);
    if (g && g.expiresAt <= now) return { ok: false as const, reason: "expired" as const };
    const next = !g?.nextCheckAt || g.nextCheckAt < now ? now : g.nextCheckAt;
    return this.transition(userId, goalId, ["paused"], { status: "active", nextCheckAt: next }, now);
  }
  cancel(userId: string, goalId: number, now = new Date()) {
    return this.transition(userId, goalId, ["draft", "active", "paused"], { status: "canceled", nextCheckAt: null }, now);
  }

  /** Worker housekeeping: anything past its expiry stops for good. */
  async expireDue(now = new Date()): Promise<number> {
    const r = await this.db.update(goals).set({ status: "expired", nextCheckAt: null, updatedAt: now })
      .where(and(notInArray(goals.status, FINAL), lte(goals.expiresAt, now))).returning({ id: goals.id });
    return r.length;
  }

  async get(userId: string, goalId: number): Promise<Goal | null> {
    const [g] = await this.db.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.userId, userId)));
    return g ?? null;
  }

  list(userId: string, opts: { includeFinal?: boolean } = {}) {
    const where = opts.includeFinal ? eq(goals.userId, userId) : and(eq(goals.userId, userId), notInArray(goals.status, FINAL));
    return this.db.select().from(goals).where(where).orderBy(desc(goals.createdAt));
  }

  /** Last successful check and last failed attempt, kept apart (a failure never hides the last real result). */
  async lastChecks(userId: string, goalId: number) {
    const g = await this.get(userId, goalId);
    if (!g) return null;
    const [ok] = await this.db.select().from(goalChecks).where(and(eq(goalChecks.goalId, goalId), ne(goalChecks.status, "PROVIDER_ERROR"))).orderBy(desc(goalChecks.checkedAt)).limit(1);
    const [bad] = await this.db.select().from(goalChecks).where(and(eq(goalChecks.goalId, goalId), eq(goalChecks.status, "PROVIDER_ERROR"))).orderBy(desc(goalChecks.checkedAt)).limit(1);
    const [{ n } = { n: 0 }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(goalChecks).where(eq(goalChecks.goalId, goalId));
    return { lastSuccess: ok ?? null, lastFailure: bad ?? null, totalChecks: n };
  }
}
