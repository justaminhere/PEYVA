/**
 * Deterministic approvals. When something waits for the user's approval (a monitoring goal, a preference), the user's
 * next reply is read by code, not by the LLM: an explicit yes executes the database operation, an explicit no discards,
 * anything else goes to the LLM and the approval keeps waiting. The reply is built from the persisted row.
 */
import { signalsIn } from "../goal/signals.ts";
import { toPersianDigits } from "../goal/persian.ts";
import { formatJalaliFa } from "../goal/dates.ts";
import { describePreference } from "../memory/preferences.ts";
import type { Session } from "./session.ts";

const NO = /(^|\s)(نه|نخیر|خیر|نمی[‌ ]?خوام|لغو|ولش کن|no|cancel)(\s|$|[!.،])/iu;

/** Stored as UTC; shown as a Jalali date and clock time in Asia/Tehran. */
export function tehranDateTime(d: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return `${formatJalaliFa(`${parts.year}-${parts.month}-${parts.day}`)}، ساعت ${toPersianDigits(`${parts.hour}:${parts.minute}`)}`;
}

export function approvalQuestion(s: Session): string | null {
  const p = s.pending;
  if (!p) return null;
  if (p.kind === "goal") return `شرایط پیگیری قیمت (هدف #${toPersianDigits(p.goalId)}، فعلاً پیش‌نویس):\n${p.summaryFa}\nبررسی‌ها هر چند ساعت یک‌بار انجام می‌شوند؛ رزرو یا پرداختی انجام نمی‌شود.\nبا همین مشخصات پیگیری را فعال کنم؟ (بله / نه)`;
  return `این ترجیح را برای سفرهای بعدی به خاطر بسپارم؟ «${describePreference(p)}» (بله / نه)`;
}

/** Returns a reply if the message resolved the pending approval, else null (the message goes to the LLM). */
export async function resolvePending(s: Session, text: string): Promise<string | null> {
  const p = s.pending;
  const pers = s.persistence;
  if (!p || !pers) return null;
  const yes = signalsIn(text).affirmation && !NO.test(text);
  const no = NO.test(text) && !signalsIn(text).affirmation;
  if (!yes && !no) return null;
  return decidePending(s, yes);
}

/** The single approval path (text "بله"/"نه" or a UI button): executes the database operation, replies from its result. */
export async function decidePending(s: Session, approve: boolean): Promise<string | null> {
  const p = s.pending;
  const pers = s.persistence;
  if (!p || !pers) return null;
  const no = !approve;
  s.pending = null;
  const now = s.now();
  if (p.kind === "goal") {
    if (no) {
      const r = await pers.goals.cancel(s.userId, p.goalId, now);
      return r.ok ? `باشه، پیگیری فعال نشد (پیش‌نویس #${toPersianDigits(p.goalId)} لغو شد).` : `پیش‌نویس فعال نشد. (وضعیت: ${r.reason})`;
    }
    const r = await pers.goals.approve(s.userId, p.goalId, p.hash, now);
    if (!r.ok) return `پیگیری فعال نشد: ${r.reason === "stale_approval" ? "شرایط از زمان نمایش تغییر کرده؛ دوباره بررسی کن." : r.reason}`;
    const g = r.goal; // persisted state
    return `پیگیری فعال شد ✅ (هدف #${toPersianDigits(g.id)}، وضعیت ذخیره‌شده: ${g.status}).\nاولین بررسی: ${g.nextCheckAt ? tehranDateTime(g.nextCheckAt) : "؟"} به وقت تهران، به شرطی که worker در حال اجرا باشد (bun run peyva:worker).\nبرای دیدن یا توقف: /goals ، /pause ${g.id} ، /cancel ${g.id}`;
  }
  if (no) return "باشه، ذخیره نکردم.";
  const r = await pers.prefs.confirm(s.userId, p.key, p.value, p.sourceMessageId, now);
  if (!r.ok) return `ذخیره نشد: ${r.reason}`;
  s.preferences = await pers.prefs.list(s.userId);
  return `ذخیره شد ✅ «${describePreference({ key: r.preference.key, value: r.preference.value })}». با /prefs می‌بینی و با /pref delete ${r.preference.key} پاک می‌شود.`;
}
