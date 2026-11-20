/** Deterministic checks on the LLM's final text. They never rewrite facts; they add visible warnings. */
import { parseAmount, toLatinDigits } from "../goal/persian.ts";

/** Money-like figures (>= 100,000 Toman) in the text that are not in the allowed set. */
export function unverifiedPrices(text: string, allowed: Set<number>): number[] {
  const t = toLatinDigits(text).replace(/٬/g, ",").replace(/٫/g, ".");
  const found: number[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(میلیارد|ملیارد|میلیون|ملیون|هزار)?/g;
  for (const m of t.matchAll(re)) {
    const p = parseAmount(m[0]);
    if (!p || p.amount < 100_000) continue;
    const ok = [...allowed].some((a) => Math.abs(a - p.amount) <= Math.max(1, a * 0.005));
    if (!ok) found.push(p.amount);
  }
  return found;
}

import { monthNamesIn } from "../goal/dates.ts";

/** Jalali months named in the reply that are not months of any date the app actually searched or holds. */
export function unverifiedMonths(text: string, isoDates: string[], toJalaliMonth: (iso: string) => number): string[] {
  if (!isoDates.length) return [];
  const allowed = new Set(isoDates.map(toJalaliMonth));
  return monthNamesIn(text).filter((m) => m.calendar === "jalali" && !allowed.has(m.month)).map((m) => m.name);
}
export const DATE_WARNING = "⚠ ماهی که در متن بالا آمده با تاریخ‌های جست‌وجوشده یکی نیست؛ تاریخ‌های جدول معتبرند.";

const ACTION_CLAIM = /(رزرو\s*(شد|کردم|کردیم|انجام شد)|بلیط(ت)?\s*(رو|را)?\s*(خریدم|گرفتم)|پرداخت\s*(شد|کردم|انجام)|یادآور(ی)?\s*.*(ساختم|تنظیم کردم|گذاشتم)|(پایش|مانیتور|پیگیری).*(فعال|شروع)\s*(شد|کردم)|(ترجیح|ترجیحت).*(ذخیره|ثبت)\s*(شد|کردم))/;

export function claimsUnauthorizedAction(text: string): boolean {
  return ACTION_CLAIM.test(text);
}

export const MONITORING_NOTICE = "یادآوری: پیگیری خودکار قیمت به پایگاه داده نیاز دارد که در این اجرا پیکربندی نشده (PEYVA_DATABASE_URL)؛ درخواستت فقط در همین گفتگو ثبت شده است.";
export const PRICE_WARNING = "⚠ متن بالا عددی دارد که با نتایج ابزار مطابقت ندارد؛ فقط قیمت‌های جدول معتبرند.";
export const ACTION_WARNING = "⚠ پیوا رزرو و پرداخت انجام نمی‌دهد و پیگیری قیمت فقط وقتی فعال است که خود برنامه پس از تأیید تو آن را از پایگاه داده اعلام کند؛ اگر متن بالا چیز دیگری گفت، درست نیست.";
