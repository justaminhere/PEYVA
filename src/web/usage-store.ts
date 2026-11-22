/** Where spend-control counters are kept between restarts. Keys are `<period>|<key>`; see `usageCounters` in the schema. */
import { inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { usageCounters } from "../db/schema.ts";

export interface UsageStore {
  /** The stored counts for these periods (a UTC day and month), as `<period>|<key>` -> n. Throws if it cannot read. */
  load(periods: string[]): Promise<Map<string, number>>;
  /** Adds n to one counter. Throws if it cannot write. */
  add(period: string, key: string, n: number): Promise<void>;
}

export class PgUsageStore implements UsageStore {
  constructor(private db: Db) {}
  async load(periods: string[]) {
    const rows = await this.db.select().from(usageCounters).where(inArray(usageCounters.period, periods));
    return new Map(rows.map((r) => [`${r.period}|${r.key}`, r.n]));
  }
  async add(period: string, key: string, n: number) {
    await this.db.insert(usageCounters).values({ period, key, n }).onConflictDoUpdate({
      target: [usageCounters.period, usageCounters.key],
      set: { n: sql`${usageCounters.n} + ${n}`, updatedAt: sql`now()` },
    });
  }
}

/** Local mode and tests: nothing is kept after the process ends. */
export class MemoryUsageStore implements UsageStore {
  private m = new Map<string, number>();
  async load(periods: string[]) { return new Map([...this.m].filter(([k]) => periods.includes(k.split("|")[0]!))); }
  async add(period: string, key: string, n: number) { const k = `${period}|${key}`; this.m.set(k, (this.m.get(k) ?? 0) + n); }
}
