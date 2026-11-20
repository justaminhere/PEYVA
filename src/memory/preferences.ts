/**
 * Long-term personal preferences (Phase 3). Structured, whitelisted keys only: nothing free-form and nothing about
 * sensitive personal attributes. The ONLY write paths are confirm() (after the user's explicit yes) and set() (the user's
 * own edit command). A proposal that was never confirmed exists only in the chat session, never here.
 * Every query is scoped to one userId.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { preferences } from "../db/schema.ts";
import { findCity } from "../travel/places.ts";
import { cleanText } from "../agent/untrusted.ts";

export const PREFERENCE_SPECS = {
  home_city: { fa: "شهر مبدأ معمول", schema: z.string().min(1).max(40).refine((v) => !!findCity(v), "unknown city") },
  preferred_airlines: { fa: "ایرلاین‌های ترجیحی", schema: z.array(z.string().min(1).max(40)).min(1).max(5) },
  min_hotel_stars: { fa: "حداقل ستارهٔ هتل", schema: z.number().int().min(1).max(5) },
  travel_style: { fa: "سبک سفر", schema: z.enum(["economy", "comfort", "luxury"]) },
  budget_preference: { fa: "ترجیح بودجه", schema: z.string().min(1).max(80) },
} as const;
export type PreferenceKey = keyof typeof PREFERENCE_SPECS;
export const PREFERENCE_KEYS = Object.keys(PREFERENCE_SPECS) as PreferenceKey[];

export function validatePreference(key: string, value: unknown): { ok: true; key: PreferenceKey; value: unknown } | { ok: false; reason: string } {
  if (!(key in PREFERENCE_SPECS)) return { ok: false, reason: `unknown preference key '${cleanText(key, 30)}'; allowed: ${PREFERENCE_KEYS.join(", ")}` };
  const r = PREFERENCE_SPECS[key as PreferenceKey].schema.safeParse(value);
  if (!r.success) return { ok: false, reason: `invalid value for ${key}: ${r.error.issues[0]?.message ?? "invalid"}` };
  const v = typeof r.data === "string" ? cleanText(r.data, 80) : Array.isArray(r.data) ? r.data.map((x) => cleanText(String(x), 40)) : r.data;
  return { ok: true, key: key as PreferenceKey, value: v };
}

export interface StoredPreference { key: PreferenceKey; value: unknown; confirmedAt: Date; sourceMessageId: number | null }

export class PreferenceStore {
  constructor(private db: Db) {}

  async list(userId: string): Promise<StoredPreference[]> {
    const rows = await this.db.select().from(preferences).where(eq(preferences.userId, userId)).orderBy(preferences.key);
    return rows.map((r) => ({ key: r.key as PreferenceKey, value: r.value, confirmedAt: r.confirmedAt, sourceMessageId: r.sourceMessageId }));
  }

  /** Persist a preference the user has just explicitly confirmed. */
  async confirm(userId: string, key: string, value: unknown, sourceMessageId: number | null, now = new Date()) {
    const v = validatePreference(key, value);
    if (!v.ok) return v;
    const [row] = await this.db.insert(preferences).values({ userId, key: v.key, value: v.value, confirmedAt: now, sourceMessageId, updatedAt: now })
      .onConflictDoUpdate({ target: [preferences.userId, preferences.key], set: { value: v.value, confirmedAt: now, sourceMessageId, updatedAt: now } }).returning();
    return { ok: true as const, preference: row! };
  }

  /** The user's own edit (a typed command is itself the confirmation). */
  set(userId: string, key: string, value: unknown, now = new Date()) {
    return this.confirm(userId, key, value, null, now);
  }

  async delete(userId: string, key: string): Promise<boolean> {
    const r = await this.db.delete(preferences).where(and(eq(preferences.userId, userId), eq(preferences.key, key))).returning({ id: preferences.id });
    return r.length > 0;
  }
}

export function describePreference(p: { key: string; value: unknown }): string {
  const spec = PREFERENCE_SPECS[p.key as PreferenceKey];
  const v = Array.isArray(p.value) ? p.value.join("، ") : String(p.value);
  return `${spec?.fa ?? p.key}: ${v}`;
}
