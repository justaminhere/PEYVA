/**
 * Resuming an agent session after a server restart, from what PostgreSQL already holds:
 *   - the LLM context: the user/assistant text messages exactly as the live session held them (tool results are
 *     left out; the current goal is given to the LLM in the system prompt on every request). Replies that never came
 *     from the LLM (errors, approvals, commands) are shown in the transcript but are not part of this context,
 *   - a versioned snapshot of the structured session state (trip goal, last comparison, pending approval),
 *     saved after every handled message.
 * Nothing is merged across conversations and nothing is invented: only the latest conversation is resumed, only
 * within a time window, a pending goal approval is kept only if that draft is still unchanged in the database, and
 * an unreadable snapshot means a fresh session (the transcript is still shown, the agent starts without it).
 */
import type { ChatMessage } from "../llm/types.ts";
import { emptyGoal, type TripGoal } from "../goal/schema.ts";
import type { ComparisonSnapshot, PendingConfirmation, Session } from "../agent/session.ts";
import type { ConversationStore } from "./conversations.ts";

export const SNAPSHOT_VERSION = 1;
export interface SessionSnapshot {
  v: 1; goal: TripGoal; lastComparison: ComparisonSnapshot | null; pending: PendingConfirmation | null; monitoringNoticeShown: boolean;
  /** LLM context (text turns only). Absent in early snapshots: then the persisted transcript is used. */
  history?: { role: "user" | "assistant"; content: string }[];
}
const MAX_HISTORY = 20;

export const snapshotOf = (s: Session): SessionSnapshot => ({
  v: SNAPSHOT_VERSION, goal: s.goal, lastComparison: s.lastComparison, pending: s.pending, monitoringNoticeShown: s.monitoringNoticeShown,
  history: s.messages.flatMap((m): { role: "user" | "assistant"; content: string }[] => (m.role === "user" ? [{ role: "user", content: m.content }]
    : m.role === "assistant" && !m.toolCalls?.length && m.content ? [{ role: "assistant", content: m.content }] : [])).slice(-MAX_HISTORY),
});

export async function saveSession(s: Session, store: ConversationStore) {
  const conv = s.persistence?.conversationId;
  if (conv) await store.saveState(s.userId, conv, snapshotOf(s), s.now());
}

/** Structural check against the current TripGoal shape: every field of an empty goal must be present with the same JSON kind. */
function looksLikeGoal(g: unknown): g is TripGoal {
  if (!g || typeof g !== "object") return false;
  const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const o = g as Record<string, unknown>;
  for (const [k, v] of Object.entries(emptyGoal())) {
    if (!(k in o)) return false;
    if (v !== null && kind(v) !== kind(o[k])) return false; // null in the template = optional object/number
  }
  const d = o.dates as Record<string, unknown>;
  return typeof d?.mode === "string";
}

function parseSnapshot(raw: unknown): SessionSnapshot | null {
  const x = raw as Partial<SessionSnapshot> | null;
  if (!x || x.v !== SNAPSHOT_VERSION || !looksLikeGoal(x.goal)) return null;
  const cmp = x.lastComparison;
  if (cmp !== null && (typeof cmp !== "object" || !Array.isArray(cmp?.results))) return null;
  const history = Array.isArray(x.history) ? x.history.filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string") : undefined;
  return { v: 1, goal: x.goal, lastComparison: cmp ?? null, pending: x.pending ?? null, monitoringNoticeShown: !!x.monitoringNoticeShown, history };
}

export type ResumeOutcome =
  | { resumed: true; conversationId: number; messages: number; droppedPending: string | null }
  | { resumed: false; reason: "no_conversation" | "too_old" | "no_state" | "unreadable_state" };

/**
 * Tries to rebuild `s` (fresh, already bound to persistence) from the user's latest conversation.
 * On success the session continues that conversation id; otherwise `s` is left untouched.
 */
export async function resumeLatest(s: Session, store: ConversationStore, opts: { maxAgeMs: number; maxMessages?: number }): Promise<ResumeOutcome> {
  const pers = s.persistence;
  if (!pers) return { resumed: false, reason: "no_conversation" };
  const c = await store.latest(s.userId);
  if (!c) return { resumed: false, reason: "no_conversation" };
  const savedAt = c.updatedAt ?? c.createdAt;
  if (s.now().getTime() - savedAt.getTime() > opts.maxAgeMs) return { resumed: false, reason: "too_old" };
  if (c.state == null) return { resumed: false, reason: "no_state" };
  const snap = parseSnapshot(c.state);
  if (!snap) return { resumed: false, reason: "unreadable_state" };

  const rows = snap.history ?? (await store.recent(s.userId, c.id, opts.maxMessages ?? MAX_HISTORY)).map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const msgs: ChatMessage[] = rows.slice(-(opts.maxMessages ?? MAX_HISTORY)).map((m) => (m.role === "user" ? { role: "user" as const, content: m.content } : { role: "assistant" as const, content: m.content }));
  while (msgs.length && msgs[0]!.role !== "user") msgs.shift(); // the LLM context starts with the user

  let pending = snap.pending;
  let droppedPending: string | null = null;
  if (pending?.kind === "goal") {
    const g = await pers.goals.get(s.userId, pending.goalId);
    const stillValid = pending.change ? !!g && (g.status === "active" || g.status === "paused") && g.proposedHash === pending.hash
      : !!g && g.status === "draft" && g.constraintsHash === pending.hash;
    if (!stillValid) { droppedPending = `goal #${pending.goalId} no longer has this ${pending.change ? "proposed change" : "draft"}`; pending = null; }
  }
  s.goal = snap.goal;
  s.lastComparison = snap.lastComparison;
  s.pending = pending;
  s.monitoringNoticeShown = snap.monitoringNoticeShown;
  s.messages = msgs;
  s.persistence = { ...pers, conversationId: c.id };
  s.resumedFrom = { conversationId: c.id, savedAt };
  return { resumed: true, conversationId: c.id, messages: msgs.length, droppedPending };
}
