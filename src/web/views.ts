/** JSON views for the web UI, built from database rows and the existing Persian formatters. */
import type { Goal } from "../goals/service.ts";
import type { CommandContext } from "../cli/commands.ts";
import { CHECK_FA, STATUS_FA } from "../cli/commands.ts";
import { tehranDateTime } from "../agent/confirm.ts";
import type { Session } from "../agent/session.ts";
import { describePreference } from "../memory/preferences.ts";
import { formatToman, toPersianDigits } from "../goal/persian.ts";

const TELEGRAM_FA: Record<string, string> = { sent: "به تلگرام رسید", pending: "در صف تلگرام", sending: "در حال ارسال به تلگرام", retrying: "تلاش دوباره برای تلگرام",
  failed: "ارسال به تلگرام ناموفق بود", unknown: "معلوم نیست به تلگرام رسیده یا نه" };

const when = (d: Date | null | undefined) => (d ? tehranDateTime(d) : null);

export interface GoalView {
  id: number; idFa: string; name: string; status: string; statusFa: string; summaryFa: string;
  nextCheckFa: string | null; approvedFa: string | null; expiresFa: string | null; totalChecksFa: string;
  lastSuccess: { atFa: string; statusFa: string; totalFa: string | null } | null;
  lastFailure: { atFa: string; reason: string } | null;
  /** A proposed change waiting for approval (the approved conditions above still apply). */
  changePendingFa: string | null;
  /** The latest match alert for this goal, as stored (in-app), with the Telegram delivery status as stored. */
  lastAlert: { id: number; atFa: string; totalFa: string | null; unread: boolean; telegramFa: string | null; textFa: string } | null;
  /** Current editable conditions (for the "change" form); the server validates every proposal. */
  editable: { budgetToman: number | null; minimumHotelStars: number | null } | null;
}

export async function goalView(ctx: CommandContext, g: Goal): Promise<GoalView> {
  const ex = ctx.registry.get(g.type);
  const parsed = ex?.schema.safeParse(g.structuredConstraints);
  const checks = await ctx.goals.lastChecks(ctx.userId, g.id);
  const ok = checks?.lastSuccess, bad = checks?.lastFailure;
  const total = (ok?.resultSummary as { match?: { totalToman?: number } | null } | null)?.match?.totalToman;
  return {
    id: g.id, idFa: toPersianDigits(g.id), name: g.name, status: g.status, statusFa: STATUS_FA[g.status] ?? g.status,
    summaryFa: ex && parsed?.success ? ex.describeFa(parsed.data) : "",
    nextCheckFa: g.status === "active" ? when(g.nextCheckAt) : null, approvedFa: when(g.approvedAt), expiresFa: when(g.expiresAt),
    totalChecksFa: toPersianDigits(checks?.totalChecks ?? 0),
    lastSuccess: ok ? { atFa: when(ok.checkedAt)!, statusFa: CHECK_FA[ok.status] ?? ok.status, totalFa: total ? `${formatToman(total)} تومان` : null } : null,
    lastFailure: bad ? { atFa: when(bad.checkedAt)!, reason: bad.errorReason ?? "خطا" } : null,
    changePendingFa: g.proposedHash ? "تغییر شرایط منتظر تأیید است؛ فعلاً شرایط قبلی اجرا می‌شود." : null,
    lastAlert: await lastAlert(ctx, g.id),
    editable: g.type === "travel_price" && parsed?.success
      ? { budgetToman: (parsed.data as { budgetToman?: number }).budgetToman ?? null, minimumHotelStars: (parsed.data as { minimumHotelStars?: number | null }).minimumHotelStars ?? null } : null,
  };
}

async function lastAlert(ctx: CommandContext, goalId: number): Promise<GoalView["lastAlert"]> {
  const r = await ctx.notifications.latestForGoal(ctx.userId, goalId);
  if (!r) return null;
  const { inApp, telegram: tg } = r;
  const payload = inApp.payload as { totalToman?: number; text?: string };
  return { id: inApp.id, atFa: when(inApp.createdAt)!, totalFa: payload.totalToman ? `${formatToman(payload.totalToman)} تومان` : null,
    unread: inApp.deliveryStatus === "stored", telegramFa: tg ? TELEGRAM_FA[tg.deliveryStatus] ?? tg.deliveryStatus : null, textFa: payload.text ?? "" };
}

export async function goalViews(ctx: CommandContext): Promise<GoalView[]> {
  const list = await ctx.goals.list(ctx.userId);
  return Promise.all(list.map((g) => goalView(ctx, g)));
}

/** What waits for the user's approval. The constraints hash never leaves the server. */
export interface DiffLine { labelFa: string; beforeFa: string; afterFa: string }
export type PendingView =
  | { kind: "goal"; goalId: number; goalIdFa: string; summaryFa: string; change: boolean; diff: DiffLine[] }
  | { kind: "preference"; key: string; textFa: string } | null;

/** "label: value" lines of two condition summaries → only the lines that differ. Works for any executor's describeFa. */
export function diffSummaries(beforeFa: string, afterFa: string): DiffLine[] {
  const parse = (t: string) => new Map(t.split("\n").map((l) => { const i = l.indexOf(":"); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] as const : [l, ""] as const; }));
  const a = parse(beforeFa), b = parse(afterFa);
  const out: DiffLine[] = [];
  for (const [k, v] of b) if (a.get(k) !== v) out.push({ labelFa: k, beforeFa: a.get(k) ?? "—", afterFa: v });
  for (const [k, v] of a) if (!b.has(k)) out.push({ labelFa: k, beforeFa: v, afterFa: "—" });
  return out;
}

export async function pendingView(s: Session, ctx?: CommandContext): Promise<PendingView> {
  const p = s.pending;
  if (!p) return null;
  if (p.kind !== "goal") return { kind: "preference", key: p.key, textFa: describePreference(p) };
  let diff: DiffLine[] = [];
  if (p.change && ctx) {
    const g = await ctx.goals.get(ctx.userId, p.goalId);
    const ex = g && ctx.registry.get(g.type);
    const cur = g && ex?.schema.safeParse(g.structuredConstraints);
    if (ex && cur?.success) diff = diffSummaries(ex.describeFa(cur.data), p.summaryFa);
  }
  return { kind: "goal", goalId: p.goalId, goalIdFa: toPersianDigits(p.goalId), summaryFa: p.summaryFa, change: !!p.change, diff };
}
