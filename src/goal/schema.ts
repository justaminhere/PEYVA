/**
 * Goal contracts.
 *
 * GoalPatch: what the LLM may send, describing ONLY what the user said in this message, "as stated"
 * (a Jalali month without a year stays without a year; a budget stays the user's text). Code converts it.
 * TripGoal: the session's merged, normalized goal (Gregorian ISO dates, integer Toman).
 */
import { z } from "zod";

const Calendar = z.enum(["jalali", "gregorian"]);
export const DayExprSchema = z.union([
  z.object({ text: z.string().min(1).max(40).describe("PREFERRED: the user's exact date words, e.g. '۱۹ آذر ۱۴۰۵', '۱۰ دی', 'فردا'") }).strict(),
  z.object({ calendar: Calendar, year: z.number().int().min(1300).max(2100).nullish(), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).strict(),
  z.object({ relative: z.enum(["today", "tomorrow", "day_after_tomorrow", "in_days"]), days: z.number().int().min(0).max(365).nullish() }).strict(),
]);
export const MonthExprSchema = z.union([
  z.object({ text: z.string().min(1).max(30).describe("PREFERRED: the user's month words, e.g. 'دی' or 'دی ۱۴۰۵'") }).strict(),
  z.object({ calendar: Calendar, year: z.number().int().min(1300).max(2100).nullish(), month: z.number().int().min(1).max(12) }).strict(),
]);

export const IntentSchema = z.enum(["trip", "flight_only", "hotel_only", "unknown"]);

export const GoalPatchSchema = z.object({
  intent: IntentSchema.optional().describe("trip = flights + hotel"),
  origin: z.string().min(1).max(60).optional().describe("departure city exactly as the user wrote it"),
  destination: z.string().min(1).max(60).optional().describe("destination city exactly as the user wrote it"),
  departureDate: DayExprSchema.optional(),
  returnDate: DayExprSchema.optional(),
  dateWindow: z.object({ from: DayExprSchema, to: DayExprSchema }).strict().optional().describe("a range: 'between 10 and 20 Dey'"),
  month: MonthExprSchema.optional().describe("a whole month: 'in Dey'"),
  datesFlexible: z.boolean().optional().describe("true when the user says any date in the range is fine, or that the date does not matter"),
  nights: z.number().int().min(1).max(30).optional(),
  adults: z.number().int().min(1).max(9).optional(),
  children: z.number().int().min(0).max(8).optional(),
  rooms: z.number().int().min(1).max(5).optional(),
  budgetText: z.string().min(1).max(80).optional().describe("the user's budget words verbatim, e.g. 'زیر ۱۵ میلیون'"),
  budgetScope: z.enum(["total", "per_person"]).optional().describe("only if the user said it"),
  minimumHotelStars: z.number().int().min(1).max(5).optional(),
  preferences: z.array(z.string().min(1).max(80)).max(10).optional().describe("soft wishes in the user's words"),
  monitoringRequested: z.boolean().optional().describe("user asked to be told later when prices change"),
  confirmAssumptions: z.boolean().optional().describe("user explicitly confirmed the assumptions PEYVA stated (e.g. the year)"),
}).strict();
export type GoalPatch = z.infer<typeof GoalPatchSchema>;

export interface Place { input: string; cityId: string | null; fa: string | null; iata: string | null; verified: boolean }

export interface TripGoal {
  intent: z.infer<typeof IntentSchema>;
  origin: Place | null;
  destination: Place | null;
  dates: {
    mode: "fixed" | "flexible" | "unknown";
    departure: string | null;
    return: string | null;
    window: { from: string; to: string } | null;
    nights: number | null;
    /** "date does not matter" with no range: we must ask for a range rather than invent one. */
    anyDate: boolean;
  };
  adults: number | null;
  children: number;
  rooms: number | null;
  /** True when rooms was derived (1 traveller -> 1 room) rather than stated. */
  roomsDerived: boolean;
  budget: { toman: number; scope: "total" | "per_person" | "unspecified"; assumedUnit: boolean; text: string } | null;
  minimumHotelStars: number | null;
  preferences: string[];
  monitoringRequested: boolean;
  /** Things PEYVA inferred that the user has not confirmed yet (e.g. the year of a Jalali date). */
  pendingAssumptions: string[];
  /** Date/amount expressions that could not be interpreted. */
  invalid: string[];
}

export const emptyGoal = (): TripGoal => ({
  intent: "unknown", origin: null, destination: null,
  dates: { mode: "unknown", departure: null, return: null, window: null, nights: null, anyDate: false },
  adults: null, children: 0, rooms: null, roomsDerived: false, budget: null, minimumHotelStars: null,
  preferences: [], monitoringRequested: false, pendingAssumptions: [], invalid: [],
});
