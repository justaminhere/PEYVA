import { expect, test } from "bun:test";
import { dayRangeIn, resolveDay } from "../src/goal/dates.ts";
import { crossCheckPatch } from "../src/agent/tools.ts";
import { applyPatch, analyze } from "../src/goal/state.ts";
import { emptyGoal } from "../src/goal/schema.ts";
import { Session } from "../src/agent/session.ts";
import { ToolRunner } from "../src/agent/tools.ts";
import { RecordedProvider } from "./support/recorded-provider.ts";

const now = new Date("2026-11-20T10:00:00Z");
const SCENARIO = "می‌خوام از تهران برم کیش، ۱۰ تا ۱۳ دسامبر ۲۰۲۶، یک نفر، سه شب، هتل دو ستاره به بالا، بودجه کل ۳۰ میلیون تومان. گزینه‌ها رو بررسی کن.";

test("day ranges in Persian and Gregorian wording", () => {
  expect(dayRangeIn(SCENARIO)).toEqual({ from: { calendar: "gregorian", month: 12, day: 10, year: 2026 }, to: { calendar: "gregorian", month: 12, day: 13, year: 2026 } });
  expect(dayRangeIn("۱۹ آذر تا ۲۲ آذر")).toEqual({ from: { calendar: "jalali", month: 9, day: 19, year: null }, to: { calendar: "jalali", month: 9, day: 22, year: null } });
  expect(dayRangeIn("10 الی 13 دی ۱۴۰۵")?.to).toEqual({ calendar: "jalali", month: 10, day: 13, year: 1405 });
  expect(dayRangeIn("۱۹ آذر، یک نفر، زیر ۳۰ میلیون")).toBeNull();
  expect(dayRangeIn("سه تا چهار شب")).toBeNull();
  expect(resolveDay({ text: "۱۰ دسامبر ۲۰۲۶" }, now)).toMatchObject({ value: "2026-12-10", assumption: null });
  expect(resolveDay({ text: "۱۳ دسامبر ۲۰۲۶" }, now)).toMatchObject({ value: "2026-12-13", assumption: null });
});

test("the scenario message: correct extraction is kept, a swapped or one-sided range is refused", () => {
  const good = crossCheckPatch({ departureDate: { text: "۱۰ دسامبر ۲۰۲۶" }, returnDate: { text: "۱۳ دسامبر ۲۰۲۶" } }, SCENARIO, emptyGoal());
  expect(good.dropped).toEqual([]);
  const swapped = crossCheckPatch({ departureDate: { text: "۱۳ دسامبر ۲۰۲۶" }, returnDate: { text: "۱۰ دسامبر ۲۰۲۶" } }, SCENARIO, emptyGoal());
  expect(swapped.patch.departureDate).toBeUndefined();
  expect(swapped.patch.returnDate).toBeUndefined();
  expect(swapped.dropped.join(" ")).toContain("range starts on day 10");
  const onlyReturn = crossCheckPatch({ origin: "تهران", returnDate: { text: "۱۳ دسامبر ۲۰۲۶" } }, SCENARIO, emptyGoal());
  expect(onlyReturn.dropped).toEqual([]); // the return day is right...
  expect(onlyReturn.unrecorded.join(" ")).toContain("the user gave a range"); // ...but the departure is still missing: the LLM is told
});

test("a single date is never taken as the return date (live bug), but answering 'when do you return?' still works", () => {
  const one = "یه سفر سه‌شبه از تهران به کیش می‌خوام، ۱۹ آذر، یک نفر، زیر ۳۰ میلیون";
  const bad = crossCheckPatch({ origin: "تهران", returnDate: { text: "۱۹ آذر" }, rooms: 1 }, one, emptyGoal());
  expect(bad.patch.returnDate).toBeUndefined();
  expect(bad.dropped.join(" ")).toContain("a single date is the departure");
  const same = crossCheckPatch({ departureDate: { text: "۱۹ آذر" }, returnDate: { text: "۱۹ آذر" } }, one, emptyGoal());
  expect(same.patch.departureDate).toEqual({ text: "۱۹ آذر" });
  expect(same.patch.returnDate).toBeUndefined();
  // the follow-up answer "22 اذر خوب" after a question about the return date (departure already known)
  const g = applyPatch(emptyGoal(), { departureDate: { text: "۱۹ آذر ۱۴۰۵" } }, now);
  const answer = crossCheckPatch({ returnDate: { text: "22 اذر" } }, "22 اذر خوب", g);
  expect(answer.patch.returnDate).toEqual({ text: "22 اذر" });
});

test("the full scenario update gives a ready goal with the right dates, stars and budget (recorded MrBilit data)", async () => {
  const s = new Session(new RecordedProvider(() => now), () => now);
  s.messages.push({ role: "user", content: SCENARIO });
  const out = await new ToolRunner(s, { autoCompare: true }).run("update_trip_goal", JSON.stringify({ intent: "trip", origin: "تهران", destination: "کیش",
    departureDate: { text: "۱۰ دسامبر ۲۰۲۶" }, returnDate: { text: "۱۳ دسامبر ۲۰۲۶" }, nights: 3, adults: 1, minimumHotelStars: 2, budgetText: "۳۰ میلیون تومان", budgetScope: "total" }));
  const j = JSON.parse(out.content);
  expect(j.checks).toMatchObject({ droppedBecauseUserDidNotSayIt: [], mentionedButNotRecorded: [] });
  expect(s.goal.dates).toMatchObject({ departure: "2026-12-10", return: "2026-12-13", nights: 3 });
  expect(s.goal).toMatchObject({ adults: 1, minimumHotelStars: 2, budget: { toman: 30_000_000 } });
  expect(analyze(s.goal, now).ready).toBe(true);
  expect(j.comparison.candidates[0]).toMatchObject({ datesFa: "۱۹ آذر ۱۴۰۵ تا ۲۲ آذر ۱۴۰۵", status: "complete" });
});
