/**
 * Calendar logic in code, not in the LLM. Jalali <-> Gregorian uses the platform's ICU "persian" calendar
 * (Intl), so no hand-written conversion table is needed. All "today" decisions use Asia/Tehran.
 */
import { todayInTehran } from "../travel/index.ts";

const persian = new Intl.DateTimeFormat("en-u-ca-persian-nu-latn", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });

export interface JDate { jy: number; jm: number; jd: number }

export const JALALI_MONTHS_FA = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];

const DAY = 86_400_000;
export const isoToUtc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
export const utcToIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => utcToIso(isoToUtc(iso) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((isoToUtc(b) - isoToUtc(a)) / DAY);

export function isRealIso(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(isoToUtc(iso)) && utcToIso(isoToUtc(iso)) === iso;
}

export function gregorianToJalali(iso: string): JDate {
  const parts = Object.fromEntries(persian.formatToParts(new Date(isoToUtc(iso))).map((p) => [p.type, p.value]));
  return { jy: Number(parts.year), jm: Number(parts.month), jd: Number(parts.day) };
}

/** Returns null for an impossible Jalali date (e.g. 1405-12-30, since 1405 is not a leap year). */
export function jalaliToGregorian(jy: number, jm: number, jd: number): string | null {
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd) || jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
  const offset = jm <= 6 ? (jm - 1) * 31 : 186 + (jm - 7) * 30;
  let guess = Date.UTC(jy + 621, 2, 20) + (offset + jd - 1) * DAY; // Farvardin 1 is March 20 or 21
  for (let i = 0; i < 4; i++) {
    const j = gregorianToJalali(utcToIso(guess));
    if (j.jy === jy && j.jm === jm && j.jd === jd) return utcToIso(guess);
    // Approximate distance, only used to move the guess; equality is checked exactly above.
    const diff = (jy - j.jy) * 365 + (jm - j.jm) * 30 + (jd - j.jd);
    if (diff === 0) break; // e.g. 10/31 vs 11/1: the target day does not exist
    guess += Math.sign(diff) * Math.max(1, Math.min(Math.abs(diff), 3)) * DAY;
  }
  for (let d = -3; d <= 3; d++) {
    const iso = utcToIso(guess + d * DAY), j = gregorianToJalali(iso);
    if (j.jy === jy && j.jm === jm && j.jd === jd) return iso;
  }
  return null;
}

export function jalaliMonthLength(jy: number, jm: number): number {
  for (const len of [31, 30, 29]) if (jalaliToGregorian(jy, jm, len)) return len;
  return 0;
}

export function formatJalaliFa(iso: string): string {
  const j = gregorianToJalali(iso);
  const fa = (n: number) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
  return `${fa(j.jd)} ${JALALI_MONTHS_FA[j.jm - 1]} ${fa(j.jy)}`;
}

// ---- date expressions the LLM reports "as stated" ----

export type Calendar = "jalali" | "gregorian";
export type DayExpr =
  | { calendar: Calendar; year?: number | null; month: number; day: number }
  | { relative: "today" | "tomorrow" | "day_after_tomorrow" | "in_days"; days?: number | null };
export type MonthExpr = { calendar: Calendar; year?: number | null; month: number };

export interface Resolved<T> {
  value: T | null;
  /** Set when we inferred something the user did not say (e.g. the year). The agent must confirm it. */
  assumption: string | null;
  error: string | null;
}

/** Resolves a day expression to a Gregorian ISO date. A missing year becomes the next occurrence and is flagged. */
export function resolveDay(e: DayExpr, now: Date): Resolved<string> {
  const today = todayInTehran(now);
  if ("relative" in e) {
    const n = e.relative === "today" ? 0 : e.relative === "tomorrow" ? 1 : e.relative === "day_after_tomorrow" ? 2 : e.days ?? NaN;
    if (!Number.isInteger(n) || n < 0 || n > 365) return { value: null, assumption: null, error: "relative day count is missing or invalid" };
    return { value: addDays(today, n), assumption: null, error: null };
  }
  const conv = (y: number) => (e.calendar === "jalali" ? jalaliToGregorian(y, e.month, e.day) : (() => {
    const iso = `${y}-${String(e.month).padStart(2, "0")}-${String(e.day).padStart(2, "0")}`;
    return isRealIso(iso) ? iso : null;
  })());
  if (e.year) {
    const iso = conv(e.year);
    return iso ? { value: iso, assumption: null, error: null } : { value: null, assumption: null, error: "this date does not exist in the calendar" };
  }
  const y0 = e.calendar === "jalali" ? gregorianToJalali(today).jy : Number(today.slice(0, 4));
  for (const y of [y0, y0 + 1]) {
    const iso = conv(y);
    if (iso && iso >= today) {
      const label = e.calendar === "jalali" ? `سال ${String(y).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!)}` : `year ${y}`;
      return { value: iso, assumption: `year not stated: assumed ${label}`, error: null };
    }
  }
  return { value: null, assumption: null, error: "this date does not exist in the calendar" };
}

/** A whole month as an ISO window (from today if the month has already started). */
export function resolveMonth(e: MonthExpr, now: Date): Resolved<{ from: string; to: string }> {
  if (e.month < 1 || e.month > 12) return { value: null, assumption: null, error: "month must be 1..12" };
  const today = todayInTehran(now);
  const window = (y: number) => {
    if (e.calendar === "jalali") {
      const len = jalaliMonthLength(y, e.month);
      const from = jalaliToGregorian(y, e.month, 1), to = jalaliToGregorian(y, e.month, len);
      return from && to ? { from, to } : null;
    }
    const from = `${y}-${String(e.month).padStart(2, "0")}-01`;
    const to = utcToIso(Date.UTC(y, e.month, 0));
    return { from, to };
  };
  const clip = (w: { from: string; to: string }) => ({ from: w.from < today ? today : w.from, to: w.to });
  if (e.year) {
    const w = window(e.year);
    if (!w) return { value: null, assumption: null, error: "invalid month" };
    if (w.to < today) return { value: null, assumption: null, error: "that month is in the past" };
    return { value: clip(w), assumption: null, error: null };
  }
  const y0 = e.calendar === "jalali" ? gregorianToJalali(today).jy : Number(today.slice(0, 4));
  for (const y of [y0, y0 + 1]) {
    const w = window(y);
    if (w && w.to >= today) {
      const label = e.calendar === "jalali" ? `${JALALI_MONTHS_FA[e.month - 1]} ${String(y).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!)}` : `${y}-${e.month}`;
      return { value: clip(w), assumption: `year not stated: assumed ${label}`, error: null };
    }
  }
  return { value: null, assumption: null, error: "invalid month" };
}
