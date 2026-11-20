/** JSON views for the web UI, built from database rows and the existing Persian formatters. */
import type { Goal } from "../goals/service.ts";
import type { CommandContext } from "../cli/commands.ts";
import { CHECK_FA, STATUS_FA } from "../cli/commands.ts";
import { tehranDateTime } from "../agent/confirm.ts";
import type { Session } from "../agent/session.ts";
import { describePreference } from "../memory/preferences.ts";
import { formatToman, toPersianDigits } from "../goal/persian.ts";

const when = (d: Date | null | undefined) => (d ? tehranDateTime(d) : null);

export interface GoalView {
  id: number; idFa: string; name: string; status: string; statusFa: string; summaryFa: string;
  nextCheckFa: string | null; approvedFa: string | null; expiresFa: string | null; totalChecksFa: string;
  lastSuccess: { atFa: string; statusFa: string; totalFa: string | null } | null;
  lastFailure: { atFa: string; reason: string } | null;
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
  };
}

export async function goalViews(ctx: CommandContext): Promise<GoalView[]> {
  const list = await ctx.goals.list(ctx.userId);
  return Promise.all(list.map((g) => goalView(ctx, g)));
}

/** What waits for the user's approval. The constraints hash never leaves the server. */
export type PendingView = { kind: "goal"; goalId: number; goalIdFa: string; summaryFa: string } | { kind: "preference"; key: string; textFa: string } | null;
export function pendingView(s: Session): PendingView {
  const p = s.pending;
  if (!p) return null;
  return p.kind === "goal" ? { kind: "goal", goalId: p.goalId, goalIdFa: toPersianDigits(p.goalId), summaryFa: p.summaryFa }
    : { kind: "preference", key: p.key, textFa: describePreference(p) };
}
