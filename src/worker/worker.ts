/**
 * Background monitoring worker (Phase 3). Runs separately from the chat. One pass:
 *  1. expire goals past their dates  2. atomically claim due active goals (FOR UPDATE SKIP LOCKED + lease)
 *  3. run each goal's executor with a timeout, one at a time by default  4. persist the check (or the failure)
 *  5. schedule the next check (bounded exponential backoff after provider errors)  6. queue a notification on a match
 *  7. release the lease  8. deliver due Telegram notifications.
 * A crashed worker's lease expires and another pass picks the goal up again.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { goalChecks, goals } from "../db/schema.ts";
import type { Goal } from "../goals/service.ts";
import { GoalService } from "../goals/service.ts";
import type { ExecutionResult, ExecutorRegistry } from "../goals/types.ts";
import type { NotificationService } from "../notify/service.ts";

export const MIN_INTERVAL_MS = 6 * 3_600_000;

export interface WorkerOptions {
  id: string;
  intervalMs?: number;
  /** Allow intervals under 6 h: only for tests and explicit development simulations. */
  allowShortInterval?: boolean;
  leaseMs?: number;
  execTimeoutMs?: number;
  batchSize?: number;
  concurrency?: number;
  retryBaseMs?: number;
  maxRetries?: number;
  gapBetweenGoalsMs?: number;
  now?: () => Date;
  log?: (e: Record<string, unknown>) => void;
}

export interface CheckOutcome { goalId: number; status: ExecutionResult["status"] | "SKIPPED"; nextCheckAt: Date | null; notified: string[]; expired: boolean; errorReason: string | null }

export class Worker {
  readonly o: Required<Omit<WorkerOptions, "log">> & { log: (e: Record<string, unknown>) => void };
  private goalsSvc: GoalService;
  constructor(private db: Db, private registry: ExecutorRegistry, private notifier: NotificationService | null, opts: WorkerOptions) {
    const intervalMs = opts.intervalMs ?? MIN_INTERVAL_MS;
    if (intervalMs < MIN_INTERVAL_MS && !opts.allowShortInterval) throw new Error(`monitoring interval must be at least 6 hours (got ${intervalMs} ms)`);
    this.o = {
      id: opts.id, intervalMs, allowShortInterval: !!opts.allowShortInterval, leaseMs: opts.leaseMs ?? 10 * 60_000, execTimeoutMs: opts.execTimeoutMs ?? 5 * 60_000,
      batchSize: opts.batchSize ?? 5, concurrency: Math.max(1, opts.concurrency ?? 1), retryBaseMs: opts.retryBaseMs ?? 15 * 60_000, maxRetries: opts.maxRetries ?? 3,
      gapBetweenGoalsMs: opts.gapBetweenGoalsMs ?? 2_000, now: opts.now ?? (() => new Date()), log: opts.log ?? (() => {}),
    };
    if (this.o.execTimeoutMs >= this.o.leaseMs) throw new Error("execution timeout must be shorter than the lease");
    this.goalsSvc = new GoalService(db, registry);
  }

  /** Atomically claim due active goals. Two workers can never claim the same goal while a lease is valid. */
  async claimDue(): Promise<Goal[]> {
    const now = this.o.now();
    const until = new Date(now.getTime() + this.o.leaseMs);
    const rows = await this.db.execute<{ id: string }>(sql`
      update goals set claimed_by = ${this.o.id}, claim_expires_at = ${until.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
      where id in (
        select id from goals
        where status = 'active' and next_check_at <= ${now.toISOString()}::timestamptz
          and (claim_expires_at is null or claim_expires_at < ${now.toISOString()}::timestamptz)
        order by next_check_at limit ${this.o.batchSize}
        for update skip locked)
      returning id`);
    if (!rows.length) return [];
    const ids = rows.map((r) => Number(r.id));
    const list = await this.db.select().from(goals).where(inArray(goals.id, ids));
    return list.sort((a, b) => (a.nextCheckAt?.getTime() ?? 0) - (b.nextCheckAt?.getTime() ?? 0));
  }

  private async execute(g: Goal): Promise<ExecutionResult> {
    const ex = this.registry.get(g.type);
    const now = this.o.now();
    const fail = (reason: string): ExecutionResult => ({ status: "PROVIDER_ERROR", provider: ex?.type ?? g.type, checkedAt: now.toISOString(), summary: {}, errorReason: reason, match: null, expired: false });
    if (!ex) return fail(`no executor for type ${g.type}`);
    const parsed = ex.schema.safeParse(g.structuredConstraints);
    if (!parsed.success) return fail("stored constraints no longer valid");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        ex.run(parsed.data, { now }),
        new Promise<ExecutionResult>((resolve) => { timer = setTimeout(() => resolve(fail(`timeout after ${this.o.execTimeoutMs} ms`)), this.o.execTimeoutMs); }),
      ]);
    } catch (e) {
      return fail(`executor crashed: ${(e as Error).message.slice(0, 200)}`);
    } finally { clearTimeout(timer); }
  }

  private nextCheck(g: Goal, r: ExecutionResult, now: Date): { next: Date; failures: number } {
    if (r.status !== "PROVIDER_ERROR") return { next: new Date(now.getTime() + this.o.intervalMs), failures: 0 };
    const failures = g.consecutiveFailures + 1;
    // Bounded: 15 min, 30 min, 60 min ... then back to the normal interval. Never a tight loop.
    const delay = failures <= this.o.maxRetries ? Math.min(this.o.retryBaseMs * 2 ** (failures - 1), this.o.intervalMs) : this.o.intervalMs;
    return { next: new Date(now.getTime() + delay), failures };
  }

  async processGoal(g: Goal): Promise<CheckOutcome> {
    const t0 = performance.now();
    const r = await this.execute(g);
    const now = this.o.now();
    await this.db.insert(goalChecks).values({ goalId: g.id, provider: r.provider, status: r.status, checkedAt: new Date(r.checkedAt),
      resultSummary: { ...r.summary, match: r.match ? { key: r.match.key, totalToman: r.match.totalToman } : null }, errorReason: r.errorReason,
      workerId: this.o.id, durationMs: Math.round(performance.now() - t0) });
    const { next, failures } = this.nextCheck(g, r, now);
    // Only the lease holder may write scheduling, and a user's pause/cancel during the run is kept as it is.
    const [after] = await this.db.update(goals).set({
      lastCheckedAt: now, nextCheckAt: r.expired ? null : next, consecutiveFailures: failures, claimedBy: null, claimExpiresAt: null, updatedAt: now,
      ...(r.expired ? { status: "expired" as const } : {}),
    }).where(and(eq(goals.id, g.id), eq(goals.claimedBy, this.o.id))).returning();
    let notified: string[] = [];
    if (r.status === "MATCH_FOUND" && r.match && this.notifier && after && after.status === "active") notified = (await this.notifier.queueMatch(after, r.match)).channels;
    const out = { goalId: g.id, status: r.status, nextCheckAt: after?.nextCheckAt ?? null, notified, expired: r.expired, errorReason: r.errorReason };
    this.o.log({ type: "check", worker: this.o.id, ...out, summary: r.summary });
    return out;
  }

  async runOnce(): Promise<{ expired: number; outcomes: CheckOutcome[]; delivered: unknown[] }> {
    const expired = await this.goalsSvc.expireDue(this.o.now());
    const claimed = await this.claimDue();
    const outcomes: CheckOutcome[] = [];
    // Bounded concurrency (default 1) with a small gap between goals, to stay gentle with the provider.
    for (let i = 0; i < claimed.length; i += this.o.concurrency) {
      if (i > 0 && this.o.gapBetweenGoalsMs) await Bun.sleep(this.o.gapBetweenGoalsMs);
      outcomes.push(...(await Promise.all(claimed.slice(i, i + this.o.concurrency).map((g) => this.processGoal(g)))));
    }
    const delivered = this.notifier ? await this.notifier.deliverPending() : [];
    return { expired, outcomes, delivered };
  }

  async loop(signal: AbortSignal, pollMs = 60_000) {
    while (!signal.aborted) {
      try { await this.runOnce(); } catch (e) { this.o.log({ type: "pass_error", worker: this.o.id, message: (e as Error).message }); }
      await new Promise((r) => { const t = setTimeout(r, pollMs); signal.addEventListener("abort", () => { clearTimeout(t); r(null); }, { once: true }); });
    }
  }
}
