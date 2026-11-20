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
  | { relative: "today" | "tomorrow" | "day_after_tomorrow" | "in_days"; days?: number | null }
  | { text: string };
export type MonthExpr = { calendar: Calendar; year?: number | null; month: number } | { text: string };
type StructDay = Exclude<DayExpr, { text: string }>;
type StructMonth = Exclude<MonthExpr, { text: string }>;

export interface Resolved<T> {
  value: T | null;
  /** Set when we inferred something the user did not say (e.g. the year). The agent must confirm it. */
  assumption: string | null;
  error: string | null;
}

/** Resolves a day expression to a Gregorian ISO date. A missing year becomes the next occurrence and is flagged. */
export function resolveDay(input: DayExpr, now: Date): Resolved<string> {
  const parsed = "text" in input ? parseDayText(input.text) : input;
  if (!parsed || "text" in parsed) return { value: null, assumption: null, error: `could not read a date in "${("text" in input ? input.text : "").slice(0, 40)}"` };
  const e: StructDay = parsed;
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
export function resolveMonth(input: MonthExpr, now: Date): Resolved<{ from: string; to: string }> {
  const parsed = "text" in input ? parseMonthText(input.text) : input;
  if (!parsed || "text" in parsed) return { value: null, assumption: null, error: `could not read a month in "${("text" in input ? input.text : "").slice(0, 40)}"` };
  const e: StructMonth = parsed;
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

// ---- deterministic parsing of the user's own date words ----

const J_MONTHS: [string, number][] = [
  ["فروردین", 1], ["اردیبهشت", 2], ["اردی بهشت", 2], ["خرداد", 3], ["تیر", 4], ["امرداد", 5], ["مرداد", 5], ["شهریور", 6],
  ["مهر", 7], ["آبان", 8], ["ابان", 8], ["آذر", 9], ["اذر", 9], ["دی", 10], ["بهمن", 11], ["اسفند", 12],
];
const G_MONTHS: [string, number][] = [
  ["ژانویه", 1], ["ژانویهٔ", 1], ["فوریه", 2], ["مارس", 3], ["آوریل", 4], ["آپریل", 4], ["مه", 5], ["می", 5], ["ژوئن", 6], ["جون", 6],
  ["ژوئیه", 7], ["جولای", 7], ["اوت", 8], ["آگوست", 8], ["سپتامبر", 9], ["اکتبر", 10], ["نوامبر", 11], ["دسامبر", 12],
];

function norm(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/‌/g, " ").replace(/\s+/g, " ").trim();
}
const word = (name: string) => new RegExp(`(^|[^\\p{L}])${name}(?=$|[^\\p{L}])`, "u");

/** Month names (Jalali or Gregorian) that appear in a text, for consistency checks. */
export function monthNamesIn(text: string): { calendar: Calendar; month: number; name: string }[] {
  const t = norm(text);
  const out: { calendar: Calendar; month: number; name: string }[] = [];
  // "دی" and "می"/"مه" are also common words; only count them next to a number ("۱۰ دی", "دی ۱۴۰۵", "ماه دی").
  const risky = new Set(["دی", "می", "مه"]);
  for (const [cal, list] of [["jalali", J_MONTHS], ["gregorian", G_MONTHS]] as const)
    for (const [name, month] of list) {
      const hit = risky.has(name) ? new RegExp(`(\\d\\s*${name}(?=$|[^\\p{L}])|(^|[^\\p{L}])${name}\\s*\\d|ماه\\s+${name}(?=$|[^\\p{L}]))`, "u").test(t) : word(name).test(t);
      if (hit && !out.some((o) => o.calendar === cal && o.month === month)) out.push({ calendar: cal, month, name });
    }
  return out;
}

/**
 * Parses the user's date words into a DayExpr: "۱۹ آذر ۱۴۰۵", "۱۹ آذر", "1405/09/19", "2026-12-10",
 * "۱۰ دسامبر ۲۰۲۶", "فردا", "پس‌فردا", "امروز", "۳ روز دیگه". Returns null when it is not a single day.
 */
export function parseDayText(text: string): StructDay | null {
  const t = norm(text);
  if (/^امروز$/.test(t)) return { relative: "today" };
  if (/^پس ?فردا$/.test(t)) return { relative: "day_after_tomorrow" };
  if (/^فردا$/.test(t)) return { relative: "tomorrow" };
  let m = t.match(/^(\d+) روز (دیگه|دیگر|بعد)$/);
  if (m) return { relative: "in_days", days: Number(m[1]) };
  m = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    const y = Number(m[1]);
    return { calendar: y < 1700 ? "jalali" : "gregorian", year: y, month: Number(m[2]), day: Number(m[3]) };
  }
  for (const [cal, list] of [["jalali", J_MONTHS], ["gregorian", G_MONTHS]] as const)
    for (const [name, month] of list) {
      m = t.match(new RegExp(`^(\\d{1,2})(?:ام|م)? ${name}(?: ماه)?(?: (?:سال )?(\\d{4}))?$`, "u"));
      if (m) return { calendar: cal, month, day: Number(m[1]), year: m[2] ? Number(m[2]) : null };
    }
  return null;
}

export interface DayRef { calendar: "jalali" | "gregorian"; month: number; day: number; year: number | null }

/**
 * A stay given as a day range in the user's own words: "۱۰ تا ۱۳ دسامبر ۲۰۲۶", "۱۹ آذر تا ۲۲ آذر", "۱۰ الی ۱۳ دی".
 * The first day is the departure, the second the return. Used to check what the LLM recorded, never to fill it in.
 */
export function dayRangeIn(text: string): { from: DayRef; to: DayRef } | null {
  const t = norm(text);
  for (const [cal, list] of [["jalali", J_MONTHS], ["gregorian", G_MONTHS]] as const)
    for (const [name, month] of list) {
      const re = new RegExp(`(?:^|[^\\d])(\\d{1,2})(?:ام|م)?(?: (${name}))? ?(?:تا|الی|-|–) ?(\\d{1,2})(?:ام|م)? ${name}(?=$|[^\\p{L}])(?: (?:سال )?(\\d{4}))?`, "u");
      const m = t.match(re);
      if (!m) continue;
      const year = m[4] ? Number(m[4]) : null;
      return { from: { calendar: cal, month, day: Number(m[1]), year }, to: { calendar: cal, month, day: Number(m[3]), year } };
    }
  return null;
}

/** Same calendar day? A missing year on either side is not a mismatch. */
export function sameDay(a: DayRef, b: { calendar?: string; month?: number; day?: number; year?: number | null } | null): boolean {
  return !!b && b.calendar === a.calendar && b.month === a.month && b.day === a.day && (a.year === null || b.year == null || a.year === b.year);
}

/** "دی", "ماه دی", "دی ۱۴۰۵", "دسامبر" -> MonthExpr */
export function parseMonthText(text: string): StructMonth | null {
  const t = norm(text).replace(/^ماه /, "");
  for (const [cal, list] of [["jalali", J_MONTHS], ["gregorian", G_MONTHS]] as const)
    for (const [name, month] of list) {
      const m = t.match(new RegExp(`^${name}(?: (?:ماه )?(?:سال )?(\\d{4}))?$`, "u"));
      if (m) return { calendar: cal, month, year: m[1] ? Number(m[1]) : null };
    }
  return null;
}
