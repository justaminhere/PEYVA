/** Deterministic data-quality checks used by the live-check command. Pure functions. */
import type { NormalizedHotel } from "../types.ts";

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

/**
 * Whole-stay check: for hotels present in both a 3-night and a 1-night search, total3/total1 should be
 * about 3 if `totalPrice` is really the whole stay. A ratio near 1 would mean it is a per-night price.
 * Nightly rates differ, so only ratios outside [1.5, 4.5] are flagged.
 */
export function stayRatio(three: NormalizedHotel[], one: NormalizedHotel[]) {
  const byId = new Map(one.filter((h) => h.totalPrice).map((h) => [h.providerHotelId, h.totalPrice!]));
  const ratios = three.filter((h) => h.totalPrice && byId.has(h.providerHotelId)).map((h) => h.totalPrice! / byId.get(h.providerHotelId)!);
  return {
    pairs: ratios.length,
    min: ratios.length ? Math.min(...ratios) : null,
    median: median(ratios),
    max: ratios.length ? Math.max(...ratios) : null,
    suspicious: ratios.filter((r) => r < 1.5 || r > 4.5).length,
  };
}

export function nullCounts<T extends object>(rows: T[], fields: readonly (keyof T)[]): Record<string, number> {
  return Object.fromEntries(fields.map((f) => [f, rows.filter((r) => r[f] === null).length]));
}
