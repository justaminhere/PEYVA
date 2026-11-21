/**
 * Goal lifecycle. Every state change is a database operation first; callers (and the LLM) report only what the
 * returned persisted row says. All operations are scoped by userId: another user's goal reads as "not found".
 *
 *   draft --approve(shown hash)--> active --pause--> paused --resume--> active
 *   any non-final --cancel--> canceled;  active/paused/draft --expire (worker)--> expired
 *   draft --updateConstraints--> draft (new conditions, approval still needed)
 *   active/paused --updateConstraints--> same status + a *proposed* change; the approved conditions keep running
 *     --approve(proposed hash)--> new conditions approved and in force;  --rejectChange--> proposal dropped, nothing else changes
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lte, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { goalChecks, goals, type GoalStatus } from "../db/schema.ts";
import type { ExecutorRegistry } from "./types.ts";

export type Goal = typeof goals.$inferSelect;
export type Fail = { ok: false; reason: "not_found" | "invalid_constraints" | "unknown_type" | "wrong_state" | "stale_approval" | "expired" | "limit"; detail?: string };

/** Optional caps on goals that run at the same time (the public MVP sets them; the local app has none). */
export interface GoalLimits { maxActivePerUser?: number; maxActiveTotal?: number }

/** Stable JSON (sorted keys) so that the same constraints always give the same hash. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const constraintsHash = (c: unknown) => createHash("sha256").update(canonical(c)).digest("hex").slice(0, 16);

const FINAL: GoalStatus[] = ["canceled", "expired"];

export class GoalService {
  constructor(private db: Db, private registry: ExecutorRegistry, private limits: GoalLimits = {}) {}

  /** null when one more goal may become active, else the "limit" failure (detail: which cap, and its size). */
  private async overLimit(userId: string): Promise<Fail | null> {
    const { maxActivePerUser: perUser, maxActiveTotal: total } = this.limits;
    if (perUser === undefined && total === undefined) return null;
    const count = async (where: ReturnType<typeof eq>) => Number((await this.db.select({ n: sql<number>`count(*)` }).from(goals).where(where))[0]?.n ?? 0);
    if (perUser !== undefined && await count(and(eq(goals.userId, userId), eq(goals.status, "active"))!) >= perUser) return { ok: false, reason: "limit", detail: `user:${perUser}` };
    if (total !== undefined && await count(eq(goals.status, "active")) >= total) return { ok: false, reason: "limit", detail: `total:${total}` };
    return null;
  }

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

  /**
   * Approve exactly the conditions the user was shown (by hash): activates a draft, or puts a proposed change of an
   * active/paused goal into force.
   */
  async approve(userId: string, goalId: number, shownHash: string, now = new Date()): Promise<{ ok: true; goal: Goal } | Fail> {
    const g = await this.get(userId, goalId);
    if (!g) return { ok: false, reason: "not_found" };
    if ((g.status === "active" || g.status === "paused") && g.proposedHash) return this.applyChange(g, shownHash, now);
    if (g.status !== "draft") return { ok: false, reason: "wrong_state", detail: g.status };
    if (g.constraintsHash !== shownHash) return { ok: false, reason: "stale_approval" };
    if (g.expiresAt <= now) return { ok: false, reason: "expired" };
    const cap = await this.overLimit(userId);
    if (cap) return cap;
    const [row] = await this.db.update(goals).set({ status: "active", approvedAt: now, approvedConstraintsHash: g.constraintsHash, nextCheckAt: now,
      consecutiveFailures: 0, updatedAt: now })
      .where(and(eq(goals.id, goalId), eq(goals.userId, userId), eq(goals.status, "draft"), eq(goals.constraintsHash, shownHash))).returning();
    return row ? { ok: true, goal: row } : { ok: false, reason: "wrong_state" };
  }

  /**
   * A material edit. A draft simply gets the new conditions (still unapproved). An active or paused goal keeps its
   * approved conditions running and records the new ones as a proposal (`hash` = what the user must approve).
   */
  async updateConstraints(userId: string, goalId: number, raw: unknown, now = new Date()):
    Promise<{ ok: true; goal: Goal; summaryFa: string; changed: boolean; proposal: boolean; hash: string } | Fail> {
    const g = await this.get(userId, goalId);
    if (!g) return { ok: false, reason: "not_found" };
    if (FINAL.includes(g.status)) return { ok: false, reason: "wrong_state", detail: g.status };
    const v = this.validate(g.type, raw);
    if (!v.ok) return v;
    const hash = constraintsHash(v.c);
    if (hash === g.constraintsHash) {
      const [row] = g.proposedHash ? await this.db.update(goals).set({ proposedConstraints: null, proposedHash: null, proposedAt: null, updatedAt: now })
        .where(and(eq(goals.id, goalId), eq(goals.userId, userId))).returning() : [g];
      return { ok: true, goal: row!, summaryFa: v.ex.describeFa(v.c), changed: false, proposal: false, hash };
    }
    if (v.ex.expiresAt(v.c) <= now) return { ok: false, reason: "expired", detail: "all dates are in the past" };
    if (g.status === "draft") {
      const [row] = await this.db.update(goals).set({ structuredConstraints: v.c as object, constraintsHash: hash, name: v.ex.nameFa(v.c),
        expiresAt: v.ex.expiresAt(v.c), updatedAt: now }).where(and(eq(goals.id, goalId), eq(goals.userId, userId), eq(goals.status, "draft"))).returning();
      return row ? { ok: true, goal: row, summaryFa: v.ex.describeFa(v.c), changed: true, proposal: false, hash } : { ok: false, reason: "wrong_state" };
    }
    const [row] = await this.db.update(goals).set({ proposedConstraints: v.c as object, proposedHash: hash, proposedAt: now, updatedAt: now })
      .where(and(eq(goals.id, goalId), eq(goals.userId, userId), inArray(goals.status, ["active", "paused"]))).returning();
    return row ? { ok: true, goal: row, summaryFa: v.ex.describeFa(v.c), changed: true, proposal: true, hash } : { ok: false, reason: "wrong_state" };
  }

  /** The user approved a proposed change (by its hash): the new conditions replace the approved ones. */
  private async applyChange(g: Goal, shownHash: string, now: Date): Promise<{ ok: true; goal: Goal } | Fail> {
    if (g.proposedHash !== shownHash) return { ok: false, reason: "stale_approval" };
    const v = this.validate(g.type, g.proposedConstraints);
    if (!v.ok) return v;
    const expiresAt = v.ex.expiresAt(v.c);
    if (expiresAt <= now) return { ok: false, reason: "expired" };
    const [row] = await this.db.update(goals).set({
      structuredConstraints: v.c as object, constraintsHash: shownHash, approvedConstraintsHash: shownHash, approvedAt: now, name: v.ex.nameFa(v.c), expiresAt,
      proposedConstraints: null, proposedHash: null, proposedAt: null, consecutiveFailures: 0, updatedAt: now,
      // an active goal checks the new conditions soon; a paused one stays paused
      ...(g.status === "active" ? { nextCheckAt: now } : {}),
    }).where(and(eq(goals.id, g.id), eq(goals.userId, g.userId), eq(goals.proposedHash, shownHash), inArray(goals.status, ["active", "paused"]))).returning();
    return row ? { ok: true, goal: row } : { ok: false, reason: "wrong_state" };
  }

  /** The user rejected a proposed change: only the proposal is removed; status, conditions and schedule are untouched. */
  async rejectChange(userId: string, goalId: number, shownHash: string, now = new Date()): Promise<{ ok: true; goal: Goal } | Fail> {
    const [row] = await this.db.update(goals).set({ proposedConstraints: null, proposedHash: null, proposedAt: null, updatedAt: now })
      .where(and(eq(goals.id, goalId), eq(goals.userId, userId), eq(goals.proposedHash, shownHash))).returning();
    if (row) return { ok: true, goal: row };
    return (await this.get(userId, goalId)) ? { ok: false, reason: "stale_approval" } : { ok: false, reason: "not_found" };
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
    if (g?.status === "paused") { const cap = await this.overLimit(userId); if (cap) return cap; }
    const next = !g?.nextCheckAt || g.nextCheckAt < now ? now : g.nextCheckAt;
    return this.transition(userId, goalId, ["paused"], { status: "active", nextCheckAt: next }, now);
  }
  cancel(userId: string, goalId: number, now = new Date()) {
    return this.transition(userId, goalId, ["draft", "active", "paused"], { status: "canceled", nextCheckAt: null, proposedConstraints: null, proposedHash: null, proposedAt: null }, now);
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
