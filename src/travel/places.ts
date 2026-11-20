/**
 * Domestic places PEYVA can search today. Deterministic lookup: the LLM passes the city as the user wrote it,
 * and this table maps it to an IATA code for flights and to the Persian name the hotel provider resolves.
 *
 * Verified live against MrBilit on 2026-11-20: THR (Tehran Mehrabad) and KIH (Kish). The other codes are standard
 * IATA codes of the main airport of each city and have NOT been verified against the provider yet.
 */
export interface City {
  id: string;
  fa: string;
  aliases: string[];
  iata: string;
  verified: boolean;
}

export const CITIES: City[] = [
  { id: "tehran", fa: "تهران", aliases: ["tehran", "teh"], iata: "THR", verified: true },
  { id: "kish", fa: "کیش", aliases: ["kish", "جزیره کیش", "کیش آیلند"], iata: "KIH", verified: true },
  { id: "mashhad", fa: "مشهد", aliases: ["mashhad"], iata: "MHD", verified: false },
  { id: "shiraz", fa: "شیراز", aliases: ["shiraz"], iata: "SYZ", verified: false },
  { id: "isfahan", fa: "اصفهان", aliases: ["isfahan", "esfahan"], iata: "IFN", verified: false },
  { id: "tabriz", fa: "تبریز", aliases: ["tabriz"], iata: "TBZ", verified: false },
  { id: "qeshm", fa: "قشم", aliases: ["qeshm", "جزیره قشم"], iata: "GSM", verified: false },
  { id: "bandar-abbas", fa: "بندرعباس", aliases: ["bandar abbas", "بندر عباس"], iata: "BND", verified: false },
  { id: "ahvaz", fa: "اهواز", aliases: ["ahvaz", "ahwaz"], iata: "AWZ", verified: false },
  { id: "yazd", fa: "یزد", aliases: ["yazd"], iata: "AZD", verified: false },
  { id: "kerman", fa: "کرمان", aliases: ["kerman"], iata: "KER", verified: false },
  { id: "rasht", fa: "رشت", aliases: ["rasht"], iata: "RAS", verified: false },
];

/** Normalizes Arabic letter variants and spacing so "كيش" / "کیش " match. */
export function normalizeFa(s: string): string {
  return s.replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/‌/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export function findCity(name: string): City | null {
  const n = normalizeFa(name).replace(/^(شهر|جزیره)\s+/, "");
  return CITIES.find((c) => normalizeFa(c.fa) === n || c.aliases.some((a) => normalizeFa(a) === n) || c.id === n) ?? null;
}
