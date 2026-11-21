/**
 * Structured view of a deterministic comparison, for the web UI. Built only from the comparison engine's output
 * (real provider results) with the same Persian rules as the terminal renderer; the browser only lays it out.
 */
import { bestOverall, type CandidateComparison, type FlightPick, type PackageOption } from "../compare/engine.ts";
import type { TripGoal } from "../goal/schema.ts";
import type { ComparisonSnapshot } from "../agent/session.ts";
import { formatJalaliFa } from "../goal/dates.ts";
import { formatToman, toPersianDigits } from "../goal/persian.ts";
import { cleanText } from "../agent/untrusted.ts";
import { isFresh } from "../travel/index.ts";
import { fa, hhmm, tehranTime } from "./fa.ts";

export interface FlightCard { airline: string; flightNumbers: string; departFa: string; arriveFa: string; priceFa: string; seatsFa: string }
export interface HotelCard { name: string; starsFa: string | null; nightsFa: string; roomsFa: string; priceFa: string }
export interface OptionCard {
  rankFa: string; totalToman: number; totalFa: string; withinBudget: boolean | null; outbound: FlightCard | null; return: FlightCard | null; hotel: HotelCard | null; warningsFa: string[];
  /** Why this option fits (or not) the user's conditions, computed from the goal the comparison was made for. */
  matchFa: string[];
}
export interface CandidateCard {
  titleFa: string; nightsFa: string; status: CandidateComparison["status"]; statusFa: string; staleFa: string | null; reasonsFa: string[]; options: OptionCard[]; notesFa: string[]; sourceFa: string | null;
  /** All options use the same two flights: the UI shows them once and lists only the hotels. */
  sharedFlights: { outbound: FlightCard | null; return: FlightCard | null } | null;
  cheapestTotalFa: string | null; cheapestWithinBudget: boolean | null; fresh: boolean; checkedFa: string | null;
}
export interface ComparisonCards {
  at: string; planNoteFa: string | null; disclosuresFa: string[]; candidates: CandidateCard[]; disclaimerFa: string;
  /** Index of the candidate with the best (cheapest in-budget) option, from the comparison engine. */
  bestIndex: number | null;
}

const flight = (f: FlightPick): FlightCard => ({
  airline: cleanText(f.airline, 30) ?? "؟", flightNumbers: f.flightNumbers.map((x) => cleanText(x, 12)).join(" + "),
  departFa: hhmm(f.departureTime), arriveFa: hhmm(f.arrivalTime), priceFa: `${formatToman(f.totalToman)} تومان`,
  seatsFa: f.seatsLeft === null ? "صندلی نامعلوم" : `${toPersianDigits(f.seatsLeft)} صندلی`,
});

function matchFa(o: PackageOption, g: TripGoal): string[] {
  const out: string[] = [];
  if (g.budget && o.withinBudget !== null) {
    const diff = Math.abs(g.budget.toman - o.totalToman);
    out.push(o.withinBudget ? (diff ? `در بودجه؛ ${formatToman(diff)} تومان کمتر از سقف` : "دقیقاً به اندازهٔ سقف بودجه") : `${formatToman(diff)} تومان بیشتر از سقف بودجه`);
  }
  if (g.minimumHotelStars && o.hotel?.stars) out.push(`هتل ${toPersianDigits(o.hotel.stars)} ستاره (حداقل ${toPersianDigits(g.minimumHotelStars)})`);
  return out;
}
const STATUS_FA: Record<CandidateComparison["status"], string> = { complete: "کامل", incomplete: "ناقص", no_match: "گزینهٔ مطابق نبود" };

const option = (o: PackageOption, i: number, g: TripGoal): OptionCard => ({
  rankFa: toPersianDigits(i + 1), totalToman: o.totalToman, totalFa: `${formatToman(o.totalToman)} تومان`, withinBudget: o.withinBudget,
  outbound: o.outbound && flight(o.outbound), return: o.return && flight(o.return),
  hotel: o.hotel && { name: cleanText(o.hotel.name, 40) ?? "؟", starsFa: o.hotel.stars ? `${toPersianDigits(o.hotel.stars)} ستاره` : null,
    nightsFa: `${toPersianDigits(o.hotel.nights)} شب`, roomsFa: `${toPersianDigits(o.hotel.rooms)} اتاق`, priceFa: `${formatToman(o.hotel.totalToman)} تومان` },
  warningsFa: o.warnings.map(fa),
  matchFa: matchFa(o, g),
});

function candidate(c: CandidateComparison, now: Date, g: TripGoal): CandidateCard {
  const srcs = [c.sources.outbound, c.sources.return, c.sources.hotel].filter((x): x is NonNullable<typeof x> => !!x);
  const checked = srcs.map((s) => s.checkedAt).sort()[0];
  const opts = c.options.slice(0, 3);
  const sameId = (a: FlightPick | null, b: FlightPick | null) => (a?.id ?? null) === (b?.id ?? null) && (a?.flightNumbers.join() ?? "") === (b?.flightNumbers.join() ?? "");
  const shared = opts.length > 1 && opts.every((o) => sameId(o.outbound, opts[0]!.outbound) && sameId(o.return, opts[0]!.return));
  const stale = srcs.some((s) => !isFresh(s.checkedAt, now));
  return {
    titleFa: `${formatJalaliFa(c.candidate.departure)} تا ${formatJalaliFa(c.candidate.return)}`, nightsFa: `${toPersianDigits(c.candidate.nights)} شب`,
    status: c.status, statusFa: STATUS_FA[c.status],
    staleFa: stale ? "بعضی نتایج قدیمی‌تر از ۱۵ دقیقه‌اند؛ این قیمت‌ها «فعلی» نیستند." : null,
    reasonsFa: c.options.length ? [] : c.reasons.map(fa),
    options: opts.map((o, i) => option(o, i, g)),
    sharedFlights: shared ? { outbound: opts[0]!.outbound && flight(opts[0]!.outbound), return: opts[0]!.return && flight(opts[0]!.return) } : null,
    cheapestTotalFa: opts[0] ? `${formatToman(opts[0].totalToman)} تومان` : null, cheapestWithinBudget: opts[0]?.withinBudget ?? null,
    fresh: !stale, checkedFa: checked ? tehranTime(checked) : null,
    notesFa: c.options.length ? c.reasons.filter((r) => r.includes("truncated")).map(fa) : [],
    sourceFa: checked ? `منبع: ${srcs[0]!.provider} · بررسی‌شده ساعت ${tehranTime(checked)} تهران` : null,
  };
}

export function comparisonCards(snap: ComparisonSnapshot, now: Date): ComparisonCards {
  return {
    at: snap.at, planNoteFa: snap.planNote ? fa(snap.planNote) : null, disclosuresFa: snap.disclosures.map(fa),
    candidates: snap.results.map((c) => candidate(c, now, snap.goal)),
    bestIndex: bestOverall(snap.results)?.candidateIndex ?? null,
    disclaimerFa: "این‌ها گزینه‌های «فهرست‌شده» در لحظهٔ بررسی‌اند، نه رزرو یا ظرفیت قطعی. رزرو را خودت در سایت ارائه‌دهنده انجام بده.",
  };
}
