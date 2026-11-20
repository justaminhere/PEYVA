/** Deterministic Persian text helpers: digits and money amounts. */

const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";

export function toLatinDigits(s: string): string {
  return s.replace(/[۰-۹٠-٩]/g, (d) => String(FA.indexOf(d) >= 0 ? FA.indexOf(d) : AR.indexOf(d)));
}

export function toPersianDigits(s: string | number): string {
  return String(s).replace(/\d/g, (d) => FA[Number(d)]!);
}

/** 25114300 -> "۲۵٬۱۱۴٬۳۰۰" */
export function formatToman(n: number): string {
  return toPersianDigits(Math.round(n).toLocaleString("en-US")).replace(/,/g, "٬");
}

const WORDS: Record<string, number> = {
  یک: 1, یه: 1, دو: 2, سه: 3, چهار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9, ده: 10,
  یازده: 11, دوازده: 12, سیزده: 13, چهارده: 14, پانزده: 15, پونزده: 15, شانزده: 16, شونزده: 16,
  هفده: 17, هیفده: 17, هجده: 18, هیجده: 18, نوزده: 19, بیست: 20, سی: 30, چهل: 40, پنجاه: 50,
  شصت: 60, هفتاد: 70, هشتاد: 80, نود: 90, صد: 100, دویست: 200, سیصد: 300, پانصد: 500,
};
const SCALES: Record<string, number> = { هزار: 1e3, تومن_هزار: 1e3, میلیون: 1e6, ملیون: 1e6, میلیارد: 1e9, ملیارد: 1e9 };

export type MoneyUnit = "toman" | "rial" | "unspecified";

export interface ParsedAmount {
  amount: number;
  unit: MoneyUnit;
}

/**
 * Parses amounts like "زیر ۱۵ میلیون", "۲۰ میلیون تومن", "۲۰۰ میلیون ریال", "15.5 میلیون",
 * "۱۵ میلیون و ۵۰۰ هزار", "بیست میلیون", "12,000,000 تومان". Returns null if no amount is found.
 */
export function parseAmount(raw: string): ParsedAmount | null {
  const s = toLatinDigits(raw).replace(/٫/g, ".").replace(/[٬،,](?=\d{3}\b)/g, "").replace(/‌/g, " ");
  const unit: MoneyUnit = /ریال/.test(s) ? "rial" : /(تومان|تومن|\bt\b)/i.test(s) ? "toman" : "unspecified";
  const tokens = s.split(/[\s]+|(?<=\d)(?=[^\d.])|(?<=[^\d.\s])(?=\d)/).map((t) => t.trim()).filter(Boolean);
  let total = 0, group = 0, seen = false;
  for (const t of tokens) {
    if (/^\d+(\.\d+)?$/.test(t)) { group += Number(t); seen = true; continue; }
    if (t in WORDS) { group += WORDS[t]!; seen = true; continue; }
    if (t in SCALES) { total += (group || 1) * SCALES[t]!; group = 0; seen = true; continue; }
  }
  if (!seen) return null;
  const amount = Math.round(total + group);
  return amount > 0 ? { amount, unit } : null;
}

/** Normalizes any amount to integer Toman. `assumed` is true when the user did not name the unit. */
export function toToman(p: ParsedAmount): { toman: number; assumedUnit: boolean } {
  if (p.unit === "rial") return { toman: Math.round(p.amount / 10), assumedUnit: false };
  return { toman: p.amount, assumedUnit: p.unit === "unspecified" };
}
