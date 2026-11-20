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

const ACTION_CLAIM = /(رزرو\s*(شد|کردم|کردیم|انجام شد)|بلیط(ت)?\s*(رو|را)?\s*(خریدم|گرفتم)|پرداخت\s*(شد|کردم|انجام)|یادآور(ی)?\s*.*(ساختم|تنظیم کردم|گذاشتم)|(پایش|مانیتور).*(فعال|شروع)\s*(شد|کردم))/;

export function claimsUnauthorizedAction(text: string): boolean {
  return ACTION_CLAIM.test(text);
}

export const MONITORING_NOTICE = "یادآوری: پایش خودکار قیمت و اطلاع‌رسانی هنوز در این نسخه پیاده نشده؛ درخواستت فقط در همین گفتگو ثبت شده است.";
export const PRICE_WARNING = "⚠ متن بالا عددی دارد که با نتایج ابزار مطابقت ندارد؛ فقط قیمت‌های جدول معتبرند.";
export const ACTION_WARNING = "⚠ پیوا در این نسخه هیچ رزرو، پرداخت، یادآوری یا پایشی انجام نمی‌دهد؛ اگر متن بالا چنین چیزی گفت، درست نیست.";
