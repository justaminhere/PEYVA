#!/usr/bin/env bun
/**
 * Goals, memory and notifications without the LLM (no API quota needed).
 *
 *   bun run peyva:goals list | show N | pause N | resume N | cancel N | budget N "<amount>" | notifications | prefs
 *   bun run peyva:goals pref set <key> <value> | pref delete <key> | telegram link | telegram verify | telegram status
 *   bun run peyva:goals create --origin تهران --destination کیش (--depart "۱۹ آذر ۱۴۰۵" | --from "۱ بهمن ۱۴۰۵" --to "۲۰ بهمن ۱۴۰۵")
 *        --nights 3 --adults 1 [--children 0] [--rooms 1] [--stars 4] --budget "۳۰ میلیون"
 * Creating or changing a goal shows the conditions and asks for approval (y/n) before it is activated.
 */
import { createInterface } from "node:readline/promises";
import { openRuntime } from "./runtime.ts";
import { HELP, runCommand } from "./commands.ts";
import { applyPatch, emptyGoal } from "../goal/state.ts";
import { GoalPatchSchema } from "../goal/schema.ts";
import { constraintsFromTripGoal } from "../goals/travel.ts";
import { approvalQuestion, resolvePending } from "../agent/confirm.ts";
import { Session } from "../agent/session.ts";

const rt = await openRuntime();
if (!rt) { console.error("PEYVA_DATABASE_URL is not set. Run `bun run db:start` and put the printed URL in .env."); process.exit(2); }
const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

async function ask(session: Session) {
  console.log(approvalQuestion(session));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("› ");
  rl.close();
  console.log((await resolvePending(session, answer)) ?? "پاسخ «بله» یا «نه» نبود؛ پیش‌نویس منتظر تأیید می‌ماند (peyva:goals list).");
}

const session = new Session(rt.provider, () => new Date(), rt.userId, { db: rt.db.db, goals: rt.goals, prefs: rt.prefs, conversationId: null });
try {
  const [cmd, ...rest] = argv;
  if (cmd === "create") {
    const patch: Record<string, unknown> = { intent: "trip", origin: flag("origin"), destination: flag("destination"), nights: Number(flag("nights")), adults: Number(flag("adults")) };
    if (flag("depart")) patch.departureDate = { text: flag("depart") };
    if (flag("from") && flag("to")) { patch.dateWindow = { from: { text: flag("from") }, to: { text: flag("to") } }; patch.datesFlexible = true; }
    if (flag("children")) patch.children = Number(flag("children"));
    if (flag("rooms")) patch.rooms = Number(flag("rooms"));
    if (flag("stars")) patch.minimumHotelStars = Number(flag("stars"));
    if (flag("budget")) patch.budgetText = flag("budget");
    const p = GoalPatchSchema.safeParse(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && !Number.isNaN(v))));
    if (!p.success) throw new Error(`invalid input: ${p.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    let g = applyPatch(emptyGoal(), p.data, new Date());
    if (g.pendingAssumptions.length) g = applyPatch(g, { confirmAssumptions: true }, new Date()); // explicit flags = the user's own statement; years shown in the summary
    const c = constraintsFromTripGoal(g);
    if (!c.ok) throw new Error(`missing: ${c.missing.join(", ")}${g.invalid.length ? ` (${g.invalid.join("; ")})` : ""}`);
    const d = await rt.goals.createDraft(rt.userId, "travel_price", c.constraints);
    if (!d.ok) throw new Error(`${d.reason} ${d.detail ?? ""}`);
    session.pending = { kind: "goal", goalId: d.goal.id, hash: d.goal.constraintsHash, summaryFa: d.summaryFa };
    await ask(session);
  } else {
    const map: Record<string, string> = { list: "/goals", show: "/goal", pause: "/pause", resume: "/resume", cancel: "/cancel", budget: "/budget",
      notifications: "/notifications", prefs: "/prefs", pref: "/pref", telegram: "/telegram", help: "/help" };
    if (!cmd || !map[cmd]) { console.log(HELP); } else {
      const r = await runCommand(rt, [map[cmd], ...rest].join(" "));
      console.log(r?.text ?? HELP);
      if (r?.pending) { session.pending = r.pending; await ask(session); }
    }
  }
} catch (e) {
  console.error(`خطا: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await rt.close();
}
