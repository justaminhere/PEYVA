/**
 * The session's trip goal as the web brief sees it, and the validated edits the brief can make.
 * Edits go through the same applyPatch/analyze code as the LLM's update_trip_goal; nothing is decided in the browser.
 */
import { z } from "zod";
import type { Session } from "../agent/session.ts";
import { analyze, applyPatch } from "../goal/state.ts";
import type { GoalPatch, TripGoal } from "../goal/schema.ts";
import { addDays, daysBetween, formatJalaliFa, resolveDay } from "../goal/dates.ts";
import { formatToman, parseAmount, toPersianDigits, toToman } from "../goal/persian.ts";
import { findCity } from "../travel/places.ts";
import { todayInTehran } from "../travel/index.ts";
import { constraintsFromTripGoal } from "../goals/travel.ts";
import { constraintsHash, type Goal } from "../goals/service.ts";

export type TripFieldKey = "origin" | "destination" | "dates" | "nights" | "travellers" | "budget" | "stars";
export interface TripField {
  key: TripFieldKey; labelFa: string; valueFa: string | null; missing: boolean;
  input: { type: "text" | "number" | "stars"; value: string; min?: number; max?: number; placeholderFa: string };
}
export interface TripView {
  empty: boolean; ready: boolean;
  fields: TripField[];
  /** Missing details in plain Persian (also marked on the fields). */
  missingFa: string[];
  conflictsFa: string[];
  /** Assumptions the user can confirm with one click (e.g. the year). */
  assumptionsFa: string[];
  results: "none" | "current" | "outdated";
  /** An approved monitoring goal that watches exactly this trip. */
  monitoredBy: { goalId: number; goalIdFa: string; status: string } | null;
}

const MISSING_FA: Record<string, string> = { origin: "مبدأ", destination: "مقصد", dates: "تاریخ رفت", nights_or_return: "تعداد شب", adults: "تعداد مسافر", rooms: "تعداد اتاق" };
const fieldOfMissing: Record<string, TripFieldKey | null> = { origin: "origin", destination: "destination", dates: "dates", nights_or_return: "nights", adults: "travellers", rooms: null };

/** analyze() conflicts are English (stable for the LLM); the brief shows them in Persian. */
export function conflictFa(c: string): string {
  const rules: [RegExp, (...m: string[]) => string][] = [
    [/^(origin|destination) "(.+)" is not a city PEYVA can search yet$/, (_, k, n) => `«${n}» شهری نیست که پیوا بتواند جست‌وجو کند (${k === "origin" ? "مبدأ" : "مقصد"})`],
    [/^origin and destination are the same city$/, () => "مبدأ و مقصد یکی است"],
    [/^departure (\S+) is in the past$/, (_, d) => `تاریخ رفت (${formatJalaliFa(d!)}) گذشته است`],
    [/^return date is not after the departure date$/, () => "تاریخ برگشت بعد از تاریخ رفت نیست"],
    [/^dates give (\d+) nights but (\d+) nights were requested$/, (_, a, b) => `تاریخ‌ها ${toPersianDigits(a!)} شب می‌شوند ولی ${toPersianDigits(b!)} شب خواسته شده`],
    [/^date range ends before it starts$/, () => "بازهٔ تاریخ قبل از شروعش تمام می‌شود"],
    [/^(\d+) nights is more than (\d+)$/, (_, a, b) => `${toPersianDigits(a!)} شب بیشتر از حد مجاز (${toPersianDigits(b!)}) است`],
    [/^(\d+) rooms for (\d+) travellers$/, (_, a, b) => `${toPersianDigits(a!)} اتاق برای ${toPersianDigits(b!)} مسافر`],
    [/^budget (\d+) Toman looks too small/, () => "بودجه برای سفر خیلی کم است (ریال یا تومان؟)"],
  ];
  for (const [re, f] of rules) { const m = c.match(re); if (m) return f(...(m as unknown as string[])); }
  return c.replace(/^[a-z ]+: /i, "");
}
const assumptionFa = (a: string) => a.replace(/^year not stated: assumed /, "سال گفته نشده بود؛ در نظر گرفته شد: ");

/** What the search depends on; the comparison is "outdated" when this differs from the goal it was made for. */
const searchKey = (g: TripGoal) => JSON.stringify([g.intent, g.origin?.iata, g.destination?.iata, g.dates.departure, g.dates.return, g.dates.window, g.dates.nights,
  g.adults, g.children, g.rooms, g.minimumHotelStars, g.budget?.toman]);

export function tripView(s: Session, goals: Goal[] = []): TripView {
  const g = s.goal, now = s.now();
  const a = analyze(g, now);
  const missing = new Set(a.missing.map((m) => fieldOfMissing[m]).filter(Boolean));
  const nights = g.dates.nights ?? (g.dates.departure && g.dates.return ? daysBetween(g.dates.departure, g.dates.return) : null);
  const ret = g.dates.return ?? (g.dates.departure && nights ? addDays(g.dates.departure, nights) : null);
  const datesFa = g.dates.departure ? `${formatJalaliFa(g.dates.departure)}${ret ? ` تا ${formatJalaliFa(ret)}` : ""}`
    : g.dates.window ? `بین ${formatJalaliFa(g.dates.window.from)} و ${formatJalaliFa(g.dates.window.to)}` : null;
  const travellersFa = g.adults !== null ? `${toPersianDigits(g.adults)} بزرگسال${g.children ? `، ${toPersianDigits(g.children)} کودک` : ""}${g.rooms !== null ? ` · ${toPersianDigits(g.rooms)} اتاق` : ""}` : null;
  const f = (key: TripFieldKey, labelFa: string, valueFa: string | null, input: TripField["input"]): TripField =>
    ({ key, labelFa, valueFa, missing: missing.has(key), input });
  const fields: TripField[] = [
    f("origin", "مبدأ", g.origin ? g.origin.fa ?? g.origin.input : null, { type: "text", value: g.origin?.fa ?? g.origin?.input ?? "", placeholderFa: "مثلاً تهران" }),
    f("destination", "مقصد", g.destination ? g.destination.fa ?? g.destination.input : null, { type: "text", value: g.destination?.fa ?? g.destination?.input ?? "", placeholderFa: "مثلاً کیش" }),
    f("dates", "تاریخ", datesFa, { type: "text", value: g.dates.departure ? formatJalaliFa(g.dates.departure) : "", placeholderFa: "تاریخ رفت، مثلاً ۱۹ آذر ۱۴۰۵" }),
    f("nights", "اقامت", nights !== null ? `${toPersianDigits(nights)} شب` : null, { type: "number", value: nights !== null ? String(nights) : "", min: 1, max: 30, placeholderFa: "تعداد شب" }),
    f("travellers", "مسافر", travellersFa, { type: "number", value: g.adults !== null ? String(g.adults) : "", min: 1, max: 9, placeholderFa: "تعداد بزرگسال" }),
    f("budget", "بودجه", g.budget ? `تا ${formatToman(g.budget.toman)} تومان${g.budget.scope === "per_person" ? " برای هر نفر" : " کل سفر"}` : null,
      { type: "text", value: g.budget ? `${formatToman(g.budget.toman)} تومان` : "", placeholderFa: "مثلاً ۳۰ میلیون" }),
    f("stars", "هتل", g.minimumHotelStars ? `حداقل ${toPersianDigits(g.minimumHotelStars)} ستاره` : null, { type: "stars", value: String(g.minimumHotelStars ?? 0), min: 0, max: 5, placeholderFa: "حداقل ستاره" }),
  ];
  const c = constraintsFromTripGoal(g);
  const hash = c.ok ? constraintsHash(c.constraints) : null;
  const watch = hash ? goals.find((x) => (x.status === "active" || x.status === "paused") && x.constraintsHash === hash) : undefined;
  return {
    empty: !g.origin && !g.destination && !datesFa && g.adults === null && !g.budget && nights === null,
    ready: a.ready, fields,
    missingFa: a.missing.map((m) => MISSING_FA[m] ?? m),
    conflictsFa: a.conflicts.map(conflictFa), assumptionsFa: g.pendingAssumptions.map(assumptionFa),
    results: !s.lastComparison ? "none" : searchKey(s.lastComparison.goal) === searchKey(g) ? "current" : "outdated",
    monitoredBy: watch ? { goalId: watch.id, goalIdFa: toPersianDigits(watch.id), status: watch.status } : null,
  };
}

export const TripEditSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("origin"), value: z.string().trim().min(1).max(60) }),
  z.object({ field: z.literal("destination"), value: z.string().trim().min(1).max(60) }),
  z.object({ field: z.literal("dates"), value: z.string().trim().min(1).max(40) }),
  z.object({ field: z.literal("nights"), value: z.coerce.number().int().min(1).max(30) }),
  z.object({ field: z.literal("travellers"), value: z.coerce.number().int().min(1).max(9) }),
  z.object({ field: z.literal("budget"), value: z.string().trim().min(1).max(40) }),
  z.object({ field: z.literal("stars"), value: z.coerce.number().int().min(0).max(5) }),
  z.object({ field: z.literal("confirmAssumptions"), value: z.literal(true) }),
]);
export type TripEdit = z.infer<typeof TripEditSchema>;

/**
 * Applies one edit from the brief. Returns the change in words, or a Persian error (nothing changed).
 * Unrelated fields are untouched; dates keep their length (changing nights moves the return date, not the departure).
 */
export function applyTripEdit(s: Session, e: TripEdit): { ok: true; changeFa: string } | { ok: false; errorFa: string } {
  const now = s.now();
  const before = tripView(s).fields.find((f) => f.key === (e.field === "confirmAssumptions" ? "dates" : e.field));
  const g = s.goal;
  const nights = g.dates.nights ?? (g.dates.departure && g.dates.return ? daysBetween(g.dates.departure, g.dates.return) : null);
  let patch: GoalPatch = {};
  switch (e.field) {
    case "origin": case "destination": {
      const city = findCity(e.value);
      if (!city) return { ok: false, errorFa: `«${e.value}» را به‌عنوان شهری که پیوا جست‌وجو می‌کند نمی‌شناسم.` };
      patch = { [e.field]: city.fa } as GoalPatch;
      break;
    }
    case "dates": {
      const r = resolveDay({ text: e.value }, now);
      if (!r.value) return { ok: false, errorFa: `تاریخ «${e.value}» را نتوانستم بخوانم. مثلاً بنویس «۱۹ آذر ۱۴۰۵» یا «10 دسامبر 2026».` };
      if (r.value < todayInTehran(now)) return { ok: false, errorFa: `${formatJalaliFa(r.value)} گذشته است.` };
      patch = { departureDate: { text: e.value }, ...(nights ? { returnDate: { text: dayText(addDays(r.value, nights)) } } : {}) };
      break;
    }
    case "nights":
      patch = { nights: e.value, ...(g.dates.departure ? { returnDate: { text: dayText(addDays(g.dates.departure, e.value)) } } : {}) };
      break;
    case "travellers": patch = { adults: e.value }; break;
    case "budget": {
      const p = parseAmount(e.value);
      if (!p || toToman(p).toman < 100_000) return { ok: false, errorFa: `مبلغ «${e.value}» را نتوانستم بخوانم. مثلاً «۳۰ میلیون».` };
      // The brief's budget field is in Toman (shown and labelled so); a value without a unit is Toman, not an assumption.
      const text = /تومان|تومن|ریال/u.test(e.value) ? e.value : `${e.value} تومان`;
      patch = { budgetText: text, budgetScope: g.budget?.scope === "per_person" ? "per_person" : "total" };
      break;
    }
    case "stars": patch = e.value ? { minimumHotelStars: e.value } : {}; break;
    case "confirmAssumptions": patch = { confirmAssumptions: true }; break;
  }
  // A new departure date replaces the old one, so assumptions made about the old date (e.g. its year) no longer apply.
  s.goal = applyPatch(e.field === "dates" ? { ...g, pendingAssumptions: [] } : g, patch, now);
  if (e.field === "stars" && e.value === 0) s.goal.minimumHotelStars = null;
  const after = tripView(s).fields.find((f) => f.key === (e.field === "confirmAssumptions" ? "dates" : e.field));
  const changeFa = e.field === "confirmAssumptions" ? "فرض‌ها تأیید شد" : `${before?.labelFa}: ${before?.valueFa ?? "—"} ← ${after?.valueFa ?? "—"}`;
  return { ok: true, changeFa };
}

/** ISO date → an unambiguous Gregorian text that resolveDay reads back exactly (keeps applyPatch the only writer). */
const G = ["ژانویه", "فوریه", "مارس", "آوریل", "مه", "ژوئن", "ژوئیه", "اوت", "سپتامبر", "اکتبر", "نوامبر", "دسامبر"];
const dayText = (iso: string) => `${Number(iso.slice(8, 10))} ${G[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
