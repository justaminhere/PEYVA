import { expect, test } from "bun:test";
import { formatToman, parseAmount, toLatinDigits, toToman } from "../src/goal/persian.ts";
import { formatJalaliFa, gregorianToJalali, jalaliMonthLength, jalaliToGregorian, resolveDay, resolveMonth } from "../src/goal/dates.ts";
import { findCity } from "../src/travel/places.ts";

const now = new Date("2026-11-20T10:00:00Z"); // 29 Aban 1405, Tehran

test("Persian and Arabic digits", () => {
  expect(toLatinDigits("۱۴۰۵/۰۹/۱۹ و ٢٠")).toBe("1405/09/19 و 20");
});

test("amounts: scales, units, words, separators", () => {
  expect(parseAmount("زیر ۱۵ میلیون")).toEqual({ amount: 15_000_000, unit: "unspecified" });
  expect(parseAmount("۲۰ میلیون تومن")).toEqual({ amount: 20_000_000, unit: "toman" });
  expect(parseAmount("۲۰۰ میلیون ریال")).toEqual({ amount: 200_000_000, unit: "rial" });
  expect(parseAmount("۱۵٫۵ میلیون")).toEqual({ amount: 15_500_000, unit: "unspecified" });
  expect(parseAmount("۱۵ میلیون و ۵۰۰ هزار تومان")).toEqual({ amount: 15_500_000, unit: "toman" });
  expect(parseAmount("بیست میلیون")).toEqual({ amount: 20_000_000, unit: "unspecified" });
  expect(parseAmount("12,000,000 تومان")).toEqual({ amount: 12_000_000, unit: "toman" });
  expect(parseAmount("ارزون")).toBeNull();
});

test("Rial -> Toman, unit assumption flagged", () => {
  expect(toToman({ amount: 200_000_000, unit: "rial" })).toEqual({ toman: 20_000_000, assumedUnit: false });
  expect(toToman({ amount: 15_000_000, unit: "unspecified" })).toEqual({ toman: 15_000_000, assumedUnit: true });
  expect(formatToman(25114300)).toBe("۲۵٬۱۱۴٬۳۰۰");
});

test("Jalali <-> Gregorian, cross-checked with the provider's own page (19 Azar 1405 = 2026-12-10)", () => {
  expect(jalaliToGregorian(1405, 9, 19)).toBe("2026-12-10");
  expect(gregorianToJalali("2026-12-10")).toEqual({ jy: 1405, jm: 9, jd: 19 });
  expect(jalaliToGregorian(1405, 1, 1)).toBe("2026-03-21");
  expect(jalaliToGregorian(1406, 1, 1)).toBe("2027-03-21");
  expect(jalaliToGregorian(1405, 12, 30)).toBeNull(); // 1405 is not a leap year
  expect(jalaliToGregorian(1403, 12, 30)).toBe("2025-03-20"); // 1403 is
  expect(jalaliMonthLength(1405, 10)).toBe(30);
  expect(formatJalaliFa("2026-12-10")).toBe("۱۹ آذر ۱۴۰۵");
});

test("round-trip over a full Jalali year", () => {
  for (let m = 1; m <= 12; m++) for (let d = 1; d <= jalaliMonthLength(1406, m); d++) {
    const iso = jalaliToGregorian(1406, m, d)!;
    expect(gregorianToJalali(iso)).toEqual({ jy: 1406, jm: m, jd: d });
  }
});

test("dates without a year resolve to the next occurrence and are flagged for confirmation", () => {
  const r = resolveDay({ calendar: "jalali", month: 10, day: 10 }, now);
  expect(r.value).toBe("2026-12-31");
  expect(r.assumption).toContain("۱۴۰۵");
  const past = resolveDay({ calendar: "jalali", month: 8, day: 1 }, now); // Aban 1 already passed -> 1406
  expect(past.value).toBe("2027-10-23");
  expect(resolveDay({ calendar: "jalali", year: 1405, month: 12, day: 30 }, now).error).not.toBeNull();
});

test("relative dates use Tehran's date", () => {
  const late = new Date("2026-11-20T21:00:00Z"); // already 21 Nov in Tehran
  expect(resolveDay({ relative: "tomorrow" }, late).value).toBe("2026-11-22");
  expect(resolveDay({ relative: "in_days" }, now).error).not.toBeNull();
});

test("month windows: Dey without year; current month clipped to today; past month rejected", () => {
  expect(resolveMonth({ calendar: "jalali", month: 10 }, now)).toMatchObject({ value: { from: "2026-12-22", to: "2027-01-20" } });
  expect(resolveMonth({ calendar: "jalali", year: 1405, month: 8 }, now).value).toEqual({ from: "2026-11-20", to: "2026-11-21" });
  expect(resolveMonth({ calendar: "jalali", year: 1405, month: 7 }, now).error).toContain("past");
});

test("city lookup normalizes Arabic letters and prefixes", () => {
  expect(findCity("كيش")?.iata).toBe("KIH");
  expect(findCity("جزیره کیش")?.iata).toBe("KIH");
  expect(findCity("Tehran")?.iata).toBe("THR");
  expect(findCity("ناکجاآباد")).toBeNull();
});
