/** Deterministic Persian rendering of comparisons and tool events for the terminal. */
import type { CandidateComparison, FlightPick, PackageOption } from "../compare/engine.ts";
import type { ComparisonSnapshot } from "../agent/session.ts";
import type { ToolEvent } from "../agent/tools.ts";
import { formatJalaliFa } from "../goal/dates.ts";
import { formatToman, toPersianDigits } from "../goal/persian.ts";
import { cleanText } from "../agent/untrusted.ts";
import { isFresh } from "../travel/index.ts";

/** Engine/analysis strings are English (stable for tests and the LLM); the terminal shows them in Persian. */
const FA_RULES: [RegExp, (...m: string[]) => string][] = [
  [/^outbound flight: /, () => "پرواز رفت: "], [/^return flight: /, () => "پرواز برگشت: "], [/^hotel: /, () => "هتل: "],
  [/^outbound: /, () => "پرواز رفت: "], [/^return: /, () => "پرواز برگشت: "],
  [/provider error \((\w+)\)/, (_, c) => `خطای ارائه‌دهنده (${c})`],
  [/not searched/, () => "جست‌وجو نشد"],
  [/provider listed nothing/, () => "ارائه‌دهنده موردی فهرست نکرد"],
  [/nothing matched the constraints/, () => "موردی با شرط‌های تو جور نبود"],
  [/provider returned (\d+) of (\d+) matches \(list truncated\)/, (_, a, b) => `ارائه‌دهنده ${toPersianDigits(a!)} مورد از ${toPersianDigits(b!)} مورد را برگرداند (فهرست کامل نیست)`],
  [/^1 traveller: 1 room$/, () => "یک مسافر: یک اتاق"],
  [/^budget unit not stated: interpreted as Toman$/, () => "واحد بودجه گفته نشد: تومان در نظر گرفته شد"],
  [/^budget treated as the total for all travellers$/, () => "بودجه برای کل سفر و همهٔ مسافران در نظر گرفته شد"],
  [/^airport code (\w+) for (.+) is not verified against the provider yet$/, (_, c, n) => `کد فرودگاه ${c} برای ${n} هنوز با ارائه‌دهنده تأیید نشده`],
  [/^flexible range: checking (\d+) departure dates \((.+)\), not every day$/, (_, n, d) => `بازهٔ منعطف: فقط ${toPersianDigits(n!)} تاریخ حرکت بررسی شد (${d})، نه همهٔ روزها`],
  [/^price assumes (\d+) identical rooms at this rate; availability of \d+ rooms is not confirmed$/, (_, n) => `قیمت برای ${toPersianDigits(n!)} اتاق یکسان با همین نرخ است؛ موجود بودن ${toPersianDigits(n!)} اتاق تأیید نشده`],
  [/^room capacity not stated by the provider$/, () => "ظرفیت اتاق را ارائه‌دهنده اعلام نکرده"],
  [/^seat count not stated by the provider$/, () => "تعداد صندلی را ارائه‌دهنده اعلام نکرده"],
  [/^needs (\d+) rooms$/, (_, n) => `${toPersianDigits(n!)} اتاق لازم است`],
];
export function fa(s: string): string {
  let out = s;
  for (const [re, f] of FA_RULES) out = out.replace(re, f as (...a: string[]) => string);
  return out;
}

export const tehranTime = (iso: string) => toPersianDigits(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)));
export const hhmm = (t: string | null) => (t ? toPersianDigits(t.slice(11, 16)) : "؟");

export function renderEvent(e: ToolEvent): string {
  switch (e.type) {
    case "goal_updated": return `  🧭 هدف به‌روز شد${e.ready ? " — آمادهٔ جست‌وجو" : e.missing.length ? ` — کمبود: ${e.missing.join("، ")}` : ""}`;
    case "search": return `  🔎 ${e.kind === "flight" ? "پرواز" : "هتل"} ${e.label}: ${e.cached ? "از نتیجهٔ تازهٔ قبلی" : e.status === "error" ? `خطا (${e.error})` : e.status === "empty" ? "نتیجه‌ای نبود" : `${toPersianDigits(e.count)} مورد`}${e.latencyMs ? ` · ${toPersianDigits((e.latencyMs / 1000).toFixed(1))} ثانیه` : ""}`;
    case "compare": return `  🧮 مقایسهٔ قطعی ${toPersianDigits(e.candidates)} تاریخ`;
    case "rejected": return `  ⛔ ابزار ${e.tool} رد شد: ${e.reason.slice(0, 140)}`;
  }
}

function flight(f: FlightPick, label: string) {
  return `    ${label}: ${cleanText(f.airline, 30) ?? "؟"} ${f.flightNumbers.join("+")} · ${hhmm(f.departureTime)}←${hhmm(f.arrivalTime)} · ${formatToman(f.totalToman)} تومان${f.seatsLeft === null ? " · صندلی نامعلوم" : ` · ${toPersianDigits(f.seatsLeft)} صندلی`}`;
}

function option(o: PackageOption, n: number) {
  const lines = [`  گزینه ${toPersianDigits(n)} — جمع ${formatToman(o.totalToman)} تومان${o.withinBudget === true ? " ✅ در بودجه" : o.withinBudget === false ? " ❌ بالاتر از بودجه" : ""}`];
  if (o.outbound) lines.push(flight(o.outbound, "رفت"));
  if (o.return) lines.push(flight(o.return, "برگشت"));
  if (o.hotel) lines.push(`    هتل: ${cleanText(o.hotel.name, 40) ?? "؟"}${o.hotel.stars ? ` (${toPersianDigits(o.hotel.stars)} ستاره)` : ""} · ${toPersianDigits(o.hotel.nights)} شب · ${toPersianDigits(o.hotel.rooms)} اتاق · ${formatToman(o.hotel.totalToman)} تومان`);
  for (const w of o.warnings) lines.push(`    ⚠ ${fa(w)}`);
  return lines.join("\n");
}

function candidate(c: CandidateComparison, idx: number, now: Date) {
  const head = `■ تاریخ ${toPersianDigits(idx + 1)}: ${formatJalaliFa(c.candidate.departure)} تا ${formatJalaliFa(c.candidate.return)} (${toPersianDigits(c.candidate.nights)} شب)`;
  const lines = [head];
  const srcs = [c.sources.outbound, c.sources.return, c.sources.hotel].filter(Boolean);
  const stale = srcs.some((s) => !isFresh(s!.checkedAt, now));
  if (stale) lines.push("  ⚠ بعضی نتایج قدیمی‌تر از ۱۵ دقیقه‌اند؛ این قیمت‌ها «فعلی» نیستند.");
  if (!c.options.length) lines.push(`  نتیجهٔ کامل نشد: ${c.reasons.map(fa).join("؛ ")}`);
  c.options.slice(0, 3).forEach((o, i) => lines.push(option(o, i + 1)));
  const notes = c.reasons.filter((r) => r.includes("truncated"));
  if (c.options.length && notes.length) lines.push(`  ℹ ${notes.map(fa).join("؛ ")}`);
  const checked = srcs.map((s) => s!.checkedAt).sort()[0];
  if (checked) lines.push(`  منبع: ${srcs[0]!.provider} · بررسی‌شده ساعت ${tehranTime(checked)} تهران`);
  return lines.join("\n");
}

export function renderComparison(snap: ComparisonSnapshot, now: Date): string {
  const out = ["──────── مقایسهٔ گزینه‌ها (محاسبهٔ قطعی، نه مدل زبانی) ────────"];
  if (snap.planNote) out.push(`ℹ ${fa(snap.planNote)}`);
  snap.results.forEach((c, i) => out.push(candidate(c, i, now)));
  if (snap.disclosures.length) out.push(`ℹ ${snap.disclosures.map(fa).join("؛ ")}`);
  out.push("این‌ها گزینه‌های «فهرست‌شده» در لحظهٔ بررسی‌اند، نه رزرو یا ظرفیت قطعی. رزرو را خودت در سایت ارائه‌دهنده انجام بده.");
  out.push("───────────────────────────────────────────────────────────");
  return out.join("\n");
}
