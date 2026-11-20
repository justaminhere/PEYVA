/**
 * Structured view of a deterministic comparison, for the web UI. Built only from the comparison engine's output
 * (real provider results) with the same Persian rules as the terminal renderer; the browser only lays it out.
 */
import type { CandidateComparison, FlightPick, PackageOption } from "../compare/engine.ts";
import type { ComparisonSnapshot } from "../agent/session.ts";
import { formatJalaliFa } from "../goal/dates.ts";
import { formatToman, toPersianDigits } from "../goal/persian.ts";
import { cleanText } from "../agent/untrusted.ts";
import { isFresh } from "../travel/index.ts";
import { fa, hhmm, tehranTime } from "./fa.ts";

export interface FlightCard { airline: string; flightNumbers: string; departFa: string; arriveFa: string; priceFa: string; seatsFa: string }
export interface HotelCard { name: string; starsFa: string | null; nightsFa: string; roomsFa: string; priceFa: string }
export interface OptionCard { rankFa: string; totalToman: number; totalFa: string; withinBudget: boolean | null; outbound: FlightCard | null; return: FlightCard | null; hotel: HotelCard | null; warningsFa: string[] }
export interface CandidateCard { titleFa: string; nightsFa: string; status: CandidateComparison["status"]; staleFa: string | null; reasonsFa: string[]; options: OptionCard[]; notesFa: string[]; sourceFa: string | null }
export interface ComparisonCards { at: string; planNoteFa: string | null; disclosuresFa: string[]; candidates: CandidateCard[]; disclaimerFa: string }

const flight = (f: FlightPick): FlightCard => ({
  airline: cleanText(f.airline, 30) ?? "؟", flightNumbers: f.flightNumbers.map((x) => cleanText(x, 12)).join(" + "),
  departFa: hhmm(f.departureTime), arriveFa: hhmm(f.arrivalTime), priceFa: `${formatToman(f.totalToman)} تومان`,
  seatsFa: f.seatsLeft === null ? "صندلی نامعلوم" : `${toPersianDigits(f.seatsLeft)} صندلی`,
});

const option = (o: PackageOption, i: number): OptionCard => ({
  rankFa: toPersianDigits(i + 1), totalToman: o.totalToman, totalFa: `${formatToman(o.totalToman)} تومان`, withinBudget: o.withinBudget,
  outbound: o.outbound && flight(o.outbound), return: o.return && flight(o.return),
  hotel: o.hotel && { name: cleanText(o.hotel.name, 40) ?? "؟", starsFa: o.hotel.stars ? `${toPersianDigits(o.hotel.stars)} ستاره` : null,
    nightsFa: `${toPersianDigits(o.hotel.nights)} شب`, roomsFa: `${toPersianDigits(o.hotel.rooms)} اتاق`, priceFa: `${formatToman(o.hotel.totalToman)} تومان` },
  warningsFa: o.warnings.map(fa),
});

function candidate(c: CandidateComparison, now: Date): CandidateCard {
  const srcs = [c.sources.outbound, c.sources.return, c.sources.hotel].filter((x): x is NonNullable<typeof x> => !!x);
  const checked = srcs.map((s) => s.checkedAt).sort()[0];
  return {
    titleFa: `${formatJalaliFa(c.candidate.departure)} تا ${formatJalaliFa(c.candidate.return)}`, nightsFa: `${toPersianDigits(c.candidate.nights)} شب`,
    status: c.status,
    staleFa: srcs.some((s) => !isFresh(s.checkedAt, now)) ? "بعضی نتایج قدیمی‌تر از ۱۵ دقیقه‌اند؛ این قیمت‌ها «فعلی» نیستند." : null,
    reasonsFa: c.options.length ? [] : c.reasons.map(fa),
    options: c.options.slice(0, 3).map(option),
    notesFa: c.options.length ? c.reasons.filter((r) => r.includes("truncated")).map(fa) : [],
    sourceFa: checked ? `منبع: ${srcs[0]!.provider} · بررسی‌شده ساعت ${tehranTime(checked)} تهران` : null,
  };
}

export function comparisonCards(snap: ComparisonSnapshot, now: Date): ComparisonCards {
  return {
    at: snap.at, planNoteFa: snap.planNote ? fa(snap.planNote) : null, disclosuresFa: snap.disclosures.map(fa),
    candidates: snap.results.map((c) => candidate(c, now)),
    disclaimerFa: "این‌ها گزینه‌های «فهرست‌شده» در لحظهٔ بررسی‌اند، نه رزرو یا ظرفیت قطعی. رزرو را خودت در سایت ارائه‌دهنده انجام بده.",
  };
}
