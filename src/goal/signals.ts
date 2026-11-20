/**
 * Deterministic "signals" in the user's own message. Used to cross-check the LLM's GoalPatch:
 * a field the user never mentioned is dropped (no invented rooms/stars/nights/budget), and a detail the user
 * did mention but the LLM left out is reported back so it can be recorded. Signals never create values on their own,
 * except the monitoring wish, which only sets a flag and shows a notice.
 */
import { parseAmount, toLatinDigits, toToman } from "./persian.ts";

const NUM = "(\\d+|یک|یه|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|نه|ده)";
const WORD_NUM: Record<string, number> = { یک: 1, یه: 1, دو: 2, سه: 3, چهار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9, ده: 10 };
const n = (s: string) => (/^\d+$/.test(s) ? Number(s) : WORD_NUM[s] ?? null);

export interface Signals {
  travellers: number | null;
  budgetToman: number | null;
  stars: number | null;
  nights: number | null;
  mentionsRooms: boolean;
  monitoring: boolean;
  affirmation: boolean;
}

export function signalsIn(raw: string): Signals {
  const t = toLatinDigits(raw).replace(/‌/g, " ").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\s+/g, " ").trim();
  const trav = t.match(new RegExp(`${NUM}\\s*(نفر|بزرگسال|بزرگ سال|مسافر)`, "u"));
  const alone = /(^|\s)(تنها|تنهایی|خودم تنها)(\s|$)/u.test(t);
  const money = t.match(/(\d[\d,٬.]*|یک|یه|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|صد|دویست|سیصد|پانصد)\s*(میلیارد|ملیارد|میلیون|ملیون)(\s*و\s*(\d+|[^\s]+)\s*هزار)?(\s*(تومان|تومن|ریال))?/u)
    ?? t.match(/(\d[\d,٬]{4,})\s*(تومان|تومن|ریال)/u);
  const parsed = money ? parseAmount(money[0]) : null;
  const stars = t.match(/(\d|یک|دو|سه|چهار|پنج)\s*ستاره/u);
  const nights = t.match(new RegExp(`${NUM}\\s*شب(?!ه\\s*ن)`, "u")); // "سه شب"/"سه شبه"; "شنبه" does not contain "شب"
  return {
    travellers: trav ? n(trav[1]!) : alone ? 1 : null,
    budgetToman: parsed ? toToman(parsed).toman : null,
    stars: stars ? n(stars[1]!) : null,
    nights: nights ? n(nights[1]!) : null,
    mentionsRooms: /اتاق/u.test(t),
    monitoring: /(خبر\s*م?\s*(کن|بده|بدید|کنید)|بهم\s*خبر|اطلاع\s*(بده|بدید|بدین)|پایش|زیر\s*نظر\s*بگیر|هر\s*وقت.*(ارزون|ارزان|مناسب)|اگه.*(ارزون|ارزان|مناسب)\s*(شد|بشه))/u.test(t),
    affirmation: /(^|\s)(آره|اره|آری|بله|بلی|درسته|درست است|صحیحه|اوکی|ok|okay|yes|همینه|دقیقا|دقیقاً|تایید|تأیید|موافقم)(\s|$|[!.،])/iu.test(t),
  };
}
