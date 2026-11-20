/**
 * Location resolution from the providers' own lookup tools. Each picker reads only
 * documented fields and returns null when the answer is missing or ambiguous; it never guesses.
 *
 * For flights we *confirm* the expected IATA code appears in the provider's lookup result
 * rather than picking "the first code", because Tehran has several airports (THR, IKA).
 */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

function collectCodes(rows: Obj[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (typeof r.code === "string") out.push(r.code.toUpperCase());
    out.push(...collectCodes(arr(r.airports)));
  }
  return out;
}

/** MrBilit mb_find_place(mode="flight"): { airports:[{code,city,airport}], cities:[{code,..., airports:[{code}]}] } */
export function confirmMrbilitFlightCode(data: unknown, expected: string): string | null {
  if (!isObj(data)) return null;
  const codes = collectCodes([...arr(data.airports), ...arr(data.cities)]);
  return codes.includes(expected.toUpperCase()) ? expected.toUpperCase() : null;
}

/** FlyToday ft_find_airport(query): { places:[{code,type,name,city,country, airports?:[...] }] } */
export function confirmFlytodayAirport(data: unknown, expected: string): string | null {
  if (!isObj(data)) return null;
  return collectCodes(arr(data.places)).includes(expected.toUpperCase()) ? expected.toUpperCase() : null;
}

const matches = (r: Obj, needles: readonly string[]) =>
  needles.some((n) => [r.name, r.name_fa, r.slug].some((v) => typeof v === "string" && v.toLowerCase().includes(n)));

/** MrBilit mb_find_place(mode="hotel"): { cities:[{id,name,slug,tags}], hotels:[...] } -> city slug */
export function pickMrbilitHotelCity(data: unknown, needles: readonly string[]): string | null {
  if (!isObj(data)) return null;
  const hits = arr(data.cities).filter((c) => matches(c, needles) && typeof c.slug === "string");
  const slugs = [...new Set(hits.map((c) => c.slug as string))];
  return slugs.length === 1 ? slugs[0]! : null;
}

/** FlyToday ft_find_hotel_place(query): { hotels:[{kind:"city",city_id,name,name_fa,...}|...] } -> city_id */
export function pickFlytodayHotelCity(data: unknown, needles: readonly string[]): number | null {
  if (!isObj(data)) return null;
  const hits = arr(data.hotels).filter((p) => p.kind === "city" && typeof p.city_id === "number" && matches(p, needles));
  const ids = [...new Set(hits.map((p) => p.city_id as number))];
  return ids.length === 1 ? ids[0]! : null;
}
