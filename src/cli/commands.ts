/**
 * Goal, memory and notification commands, shared by the chat (/goals …) and the standalone CLI (peyva:goals …).
 * Every answer is built from what the database returned.
 */
import type { GoalService, Goal } from "../goals/service.ts";
import type { ExecutorRegistry } from "../goals/types.ts";
import type { PreferenceStore } from "../memory/preferences.ts";
import { describePreference } from "../memory/preferences.ts";
import type { NotificationService, TelegramLinker } from "../notify/service.ts";
import { parseAmount, toToman, toPersianDigits, formatToman } from "../goal/persian.ts";
import { tehranDateTime } from "../agent/confirm.ts";
import type { PendingConfirmation } from "../agent/session.ts";

export interface CommandContext {
  userId: string;
  goals: GoalService;
  registry: ExecutorRegistry;
  prefs: PreferenceStore;
  notifications: NotificationService;
  linker: TelegramLinker | null;
}
export interface CommandResult { text: string; pending?: PendingConfirmation }

const STATUS_FA: Record<string, string> = { draft: "پیش‌نویس (منتظر تأیید)", active: "فعال", paused: "متوقف", canceled: "لغو شده", expired: "منقضی" };
const CHECK_FA: Record<string, string> = { MATCH_FOUND: "گزینهٔ مطابق پیدا شد", NO_MATCH: "گزینه‌ای در بودجه نبود", INCOMPLETE_DATA: "دادهٔ کافی نبود", PROVIDER_ERROR: "خطای ارائه‌دهنده" };
const when = (d: Date | null | undefined) => (d ? tehranDateTime(d) : "—");
const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null);

function goalLine(g: Goal) {
  return `#${toPersianDigits(g.id)} · ${g.name} · ${STATUS_FA[g.status] ?? g.status}${g.status === "active" ? ` · بررسی بعدی ${when(g.nextCheckAt)}` : ""}`;
}

export const HELP = [
  "/goals — هدف‌های پیگیری", "/goal N — جزئیات و آخرین بررسی", "/pause N · /resume N · /cancel N",
  "/budget N <مبلغ> — تغییر بودجه (نیاز به تأیید دوباره)", "/notifications — اعلان‌ها",
  "/prefs · /pref set <key> <value> · /pref delete <key>", "/telegram link | verify | status | unlink",
].join("\n");

export async function runCommand(ctx: CommandContext, line: string): Promise<CommandResult | null> {
  const [cmd, ...args] = line.trim().split(/\s+/);
  const id = num(args[0]);
  const failText = (r: { reason: string; detail?: string }) => `انجام نشد: ${r.reason === "not_found" ? "هدفی با این شماره نیست" : r.reason}${r.detail ? ` (${r.detail})` : ""}`;
  switch (cmd) {
    case "/help": return { text: HELP };
    case "/goals": {
      const list = await ctx.goals.list(ctx.userId);
      return { text: list.length ? list.map(goalLine).join("\n") : "هیچ هدف پیگیری فعالی نداری." };
    }
    case "/goal": {
      if (id === null) return { text: "شمارهٔ هدف را بنویس: /goal 3" };
      const g = await ctx.goals.get(ctx.userId, id);
      if (!g) return { text: "هدفی با این شماره نیست." };
      const ex = ctx.registry.get(g.type);
      const checks = await ctx.goals.lastChecks(ctx.userId, id);
      const ok = checks?.lastSuccess, bad = checks?.lastFailure;
      const okTotal = (ok?.resultSummary as { match?: { totalToman: number } | null } | null)?.match?.totalToman;
      return { text: [
        goalLine(g),
        ex ? ex.describeFa(ex.schema.parse(g.structuredConstraints)) : "",
        `تأیید: ${when(g.approvedAt)} · انقضا: ${when(g.expiresAt)} · تعداد بررسی‌ها: ${toPersianDigits(checks?.totalChecks ?? 0)}`,
        `آخرین بررسی موفق: ${ok ? `${when(ok.checkedAt)} — ${CHECK_FA[ok.status]}${okTotal ? ` (${formatToman(okTotal)} تومان)` : ""}` : "هنوز نه"}`,
        `آخرین تلاش ناموفق: ${bad ? `${when(bad.checkedAt)} — ${bad.errorReason ?? "خطا"}` : "ندارد"}`,
      ].filter(Boolean).join("\n") };
    }
    case "/pause": case "/resume": case "/cancel": {
      if (id === null) return { text: `شمارهٔ هدف را بنویس: ${cmd} 3` };
      const r = cmd === "/pause" ? await ctx.goals.pause(ctx.userId, id) : cmd === "/resume" ? await ctx.goals.resume(ctx.userId, id) : await ctx.goals.cancel(ctx.userId, id);
      return { text: r.ok ? `انجام شد. ${goalLine(r.goal)}` : failText(r) };
    }
    case "/budget": {
      const text = args.slice(1).join(" ");
      const amount = text ? parseAmount(text) : null;
      if (id === null || !amount) return { text: "مثال: /budget 3 ۲۰ میلیون تومان" };
      const g = await ctx.goals.get(ctx.userId, id);
      if (!g) return { text: "هدفی با این شماره نیست." };
      const r = await ctx.goals.updateConstraints(ctx.userId, id, { ...(g.structuredConstraints as object), budgetToman: toToman(amount).toman });
      if (!r.ok) return { text: failText(r) };
      if (!r.changed) return { text: "بودجه همان قبلی است؛ چیزی تغییر نکرد." };
      return { text: `شرایط تغییر کرد؛ پیگیری تا تأیید دوباره متوقف است.`, pending: { kind: "goal", goalId: r.goal.id, hash: r.goal.constraintsHash, summaryFa: r.summaryFa } };
    }
    case "/notifications": {
      const list = await ctx.notifications.list(ctx.userId, 10);
      await ctx.notifications.markRead(ctx.userId);
      if (!list.length) return { text: "اعلانی نداری." };
      return { text: list.map((n) => `[${n.channel === "in_app" ? "برنامه" : "تلگرام"} · ${n.deliveryStatus} · ${when(n.createdAt)}]\n${(n.payload as { text?: string }).text ?? ""}`).join("\n\n") };
    }
    case "/prefs": {
      const list = await ctx.prefs.list(ctx.userId);
      return { text: list.length ? list.map((p) => `${p.key} — ${describePreference(p)}`).join("\n") : "هیچ ترجیحی ذخیره نشده." };
    }
    case "/pref": {
      const [sub, key, ...rest] = args;
      if (sub === "delete" && key) return { text: (await ctx.prefs.delete(ctx.userId, key)) ? "پاک شد." : "چنین ترجیحی نبود." };
      if (sub === "set" && key && rest.length) {
        const raw = rest.join(" ");
        const value = key === "preferred_airlines" ? raw.split(/[،,]\s*/) : /^\d+$/.test(raw) ? Number(raw) : raw;
        const r = await ctx.prefs.set(ctx.userId, key, value);
        return { text: r.ok ? `ذخیره شد: ${describePreference({ key, value: r.preference.value })}` : `ذخیره نشد: ${r.reason}` };
      }
      return { text: "مثال: /pref set min_hotel_stars 4  ·  /pref delete min_hotel_stars" };
    }
    case "/telegram": {
      if (!ctx.linker) return { text: "تلگرام پیکربندی نشده (TELEGRAM_BOT_TOKEN در .env)." };
      const sub = args[0];
      if (sub === "link") {
        const c = await ctx.linker.createCode(ctx.userId);
        return { text: `از تلگرام خودت این را برای ربات بفرست (۱۵ دقیقه اعتبار دارد):\n${c.deepLink ?? `/start ${c.code}`}\nبعد اینجا بنویس: /telegram verify` };
      }
      if (sub === "verify") { const r = await ctx.linker.verify(ctx.userId); return { text: r.linked ? "تلگرام وصل شد ✅" : `هنوز وصل نشد: ${r.reason}` }; }
      if (sub === "status") { const s = await ctx.linker.status(ctx.userId); return { text: s.linked ? `وصل است (از ${when(s.verifiedAt)})` : "وصل نیست." }; }
      if (sub === "unlink") { await ctx.linker.unlink(ctx.userId); return { text: "تلگرام جدا شد." }; }
      return { text: "/telegram link | verify | status | unlink" };
    }
  }
  return null;
}
