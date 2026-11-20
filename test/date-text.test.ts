import { expect, test } from "bun:test";
import { monthNamesIn, parseDayText, parseMonthText, resolveDay, resolveMonth } from "../src/goal/dates.ts";
import { monthMismatch } from "../src/agent/tools.ts";
import { unverifiedMonths } from "../src/agent/guards.ts";
import { gregorianToJalali } from "../src/goal/dates.ts";
import { runTurn } from "../src/agent/agent.ts";
import { Session } from "../src/agent/session.ts";
import { DATE_WARNING } from "../src/agent/guards.ts";
import { RecordedProvider } from "./support/recorded-provider.ts";
import { ScriptedLlm, call, say, tools } from "./support/scripted-llm.ts";

const now = new Date("2026-11-20T10:00:00Z");

test("the user's own date words are parsed by code", () => {
  expect(parseDayText("۱۹ آذر ۱۴۰۵")).toEqual({ calendar: "jalali", month: 9, day: 19, year: 1405 });
  expect(parseDayText("۱۹ آذر")).toEqual({ calendar: "jalali", month: 9, day: 19, year: null });
  expect(parseDayText("۱۰ دی")).toEqual({ calendar: "jalali", month: 10, day: 10, year: null });
  expect(parseDayText("۵ اردی‌بهشت")).toEqual({ calendar: "jalali", month: 2, day: 5, year: null });
  expect(parseDayText("1405/09/19")).toEqual({ calendar: "jalali", year: 1405, month: 9, day: 19 });
  expect(parseDayText("2026-12-10")).toEqual({ calendar: "gregorian", year: 2026, month: 12, day: 10 });
  expect(parseDayText("۱۰ دسامبر ۲۰۲۶")).toEqual({ calendar: "gregorian", month: 12, day: 10, year: 2026 });
  expect(parseDayText("فردا")).toEqual({ relative: "tomorrow" });
  expect(parseDayText("پس‌فردا")).toEqual({ relative: "day_after_tomorrow" });
  expect(parseDayText("۳ روز دیگه")).toEqual({ relative: "in_days", days: 3 });
  expect(parseDayText("یه روز خوب")).toBeNull();
  expect(parseMonthText("ماه دی")).toEqual({ calendar: "jalali", month: 10, year: null });
  expect(parseMonthText("دی ۱۴۰۵")).toEqual({ calendar: "jalali", month: 10, year: 1405 });
});

test("text dates resolve to the right Gregorian day", () => {
  expect(resolveDay({ text: "۱۹ آذر ۱۴۰۵" }, now).value).toBe("2026-12-10");
  expect(resolveDay({ text: "نمی‌دونم" }, now).error).toContain("could not read");
  expect(resolveMonth({ text: "دی" }, now).value).toEqual({ from: "2026-12-22", to: "2027-01-20" });
});

test("month names are detected; ambiguous short words only next to numbers", () => {
  expect(monthNamesIn("۱۹ آذر ۱۴۰۵").map((m) => m.month)).toEqual([9]);
  expect(monthNamesIn("بین ۱۰ تا ۲۰ دی").map((m) => m.month)).toEqual([10]);
  expect(monthNamesIn("می‌خوام برم کیش")).toEqual([]); // "می" here is a verb prefix, not May
  expect(monthNamesIn("دیروز گفتم")).toEqual([]);
});

test("monthMismatch rejects a number that contradicts the named month", () => {
  expect(monthMismatch([{ calendar: "jalali", year: 1405, month: 11, day: 19 }], "۱۹ آذر ۱۴۰۵")).toContain("month mismatch");
  expect(monthMismatch([{ calendar: "jalali", year: 1405, month: 9, day: 19 }], "۱۹ آذر ۱۴۰۵")).toBeNull();
  expect(monthMismatch([{ text: "۱۹ آذر ۱۴۰۵" }], "۱۹ آذر ۱۴۰۵")).toBeNull();
  expect(monthMismatch([{ calendar: "jalali", year: 1405, month: 11, day: 19 }], "همون روز")).toBeNull(); // no month named: nothing to check
});

test("REGRESSION (live run 2026-11-20 14:08 UTC): '۱۹ آذر ۱۴۰۵' sent as Bahman is rejected, the retry with text searches 2026-12-10", async () => {
  const p = new RecordedProvider(() => now);
  const s = new Session(p, () => now);
  const llm = new ScriptedLlm([
    tools(call("update_trip_goal", { intent: "trip", origin: "تهران", destination: "کیش", nights: 3, adults: 1, budgetText: "۳۰ میلیون" })), say("تاریخ؟"),
    // exactly what qwen/qwen3.8-27b did live: month 11 instead of 9
    tools(call("update_trip_goal", { departureDate: { calendar: "jalali", year: 1405, month: 11, day: 19 } })),
    (msgs) => { expect(msgs.at(-1)!.content as string).toContain("month mismatch"); return tools(call("update_trip_goal", { departureDate: { text: "۱۹ آذر ۱۴۰۵" } })); },
    tools(call("compare_trip_options", {})),
    say("برای ۱۹ آذر ۱۴۰۵ تا ۲۲ آذر ۱۴۰۵، گزینه ۱ در بودجه است."),
  ]);
  await runTurn(s, llm, "تهران، یک نفر، بودجه ۳۰ میلیون، سه شب کیش");
  const t = await runTurn(s, llm, "۱۹ آذر ۱۴۰۵");
  expect(s.goal.dates.departure).toBe("2026-12-10");
  expect(p.calls[0]).toBe("F:THR-KIH-2026-12-10");
  expect(t.toolCalls.map((c) => c.ok)).toEqual([false, true, true]);
  expect(t.warnings).not.toContain(DATE_WARNING);
  expect(s.lastComparison!.results[0]!.options[0]!.totalToman).toBe(25_114_300);
});

test("a reply naming a month that was not searched gets a visible warning", () => {
  const toJ = (iso: string) => gregorianToJalali(iso).jm;
  expect(unverifiedMonths("برای ۱۹ آذر چیزی پیدا نشد", ["2027-02-08", "2027-02-11"], toJ)).toEqual(["آذر"]); // the live reply vs Bahman dates
  expect(unverifiedMonths("برای ۱۹ آذر", ["2026-12-10"], toJ)).toEqual([]);
});
