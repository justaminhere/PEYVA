/**
 * Reusable goal contract. A goal type = a zod schema for its constraints + an executor. Only "travel_price" exists
 * today; product prices, new-vs-used purchases or groceries would register their own executor here later.
 */
import type { z } from "zod";
import type { CheckStatus } from "../db/schema.ts";

export interface ExecutionMatch {
  /** Identity of the matching option (dates + flight/hotel ids). Same key + same price = unchanged result. */
  key: string;
  totalToman: number;
  provider: string;
  checkedAt: string;
  /** What the notification shows (no prices invented, all from the deterministic comparison). */
  details: Record<string, unknown>;
}

export interface ExecutionResult {
  status: CheckStatus;
  provider: string;
  checkedAt: string;
  /** Minimal summary stored in goal_checks (no raw provider responses). */
  summary: Record<string, unknown>;
  errorReason: string | null;
  match: ExecutionMatch | null;
  /** The goal can never match again (e.g. all dates are in the past). */
  expired: boolean;
}

export interface GoalExecutor<C> {
  type: string;
  schema: z.ZodType<C>;
  nameFa(c: C): string;
  describeFa(c: C): string;
  expiresAt(c: C): Date;
  run(c: C, ctx: { now: Date }): Promise<ExecutionResult>;
}

export class ExecutorRegistry {
  private map = new Map<string, GoalExecutor<any>>();
  register<C>(e: GoalExecutor<C>) { this.map.set(e.type, e); return this; }
  get(type: string): GoalExecutor<unknown> | null { return this.map.get(type) ?? null; }
  types() { return [...this.map.keys()]; }
}
