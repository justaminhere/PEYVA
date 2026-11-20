/**
 * One user message → one reply, with Phase 3 wiring around the LLM turn:
 *   1. an approval is waiting → the reply is resolved by code (yes/no), never by the LLM;
 *   2. a slash command → executed against the database (no LLM, no quota);
 *   3. otherwise the normal agent turn; if it proposed something, the app appends the approval question.
 * User and assistant messages are persisted when a database is configured.
 */
import type { LlmClient } from "../llm/types.ts";
import { runTurn, type TurnHooks, type TurnResult } from "./agent.ts";
import { approvalQuestion, resolvePending } from "./confirm.ts";
import type { Session } from "./session.ts";
import { runCommand, type CommandContext } from "../cli/commands.ts";
import type { ConversationStore } from "../memory/conversations.ts";

export interface HandleResult {
  /** Full text for text-only clients (terminal): the answer plus, if something now waits for approval, the question. */
  reply: string;
  /** The answer without the approval question (clients with an approval card show the question themselves). */
  text: string;
  question: string | null;
  source: "approval" | "command" | "llm";
  turn: TurnResult | null;
}

export async function handleMessage(s: Session, llm: LlmClient, text: string, opts: { commands?: CommandContext | null; store?: ConversationStore | null; hooks?: TurnHooks } = {}): Promise<HandleResult> {
  const conv = s.persistence?.conversationId ?? null;
  const store = opts.store ?? null;
  s.lastUserMessageId = store && conv ? await store.add(s.userId, conv, "user", text, s.now()) : null;
  const finish = async (r: HandleResult) => {
    if (store && conv) await store.add(s.userId, conv, "assistant", r.reply, s.now());
    return r;
  };

  if (s.pending) {
    const resolved = await resolvePending(s, text);
    if (resolved) return finish({ reply: resolved, text: resolved, question: null, source: "approval", turn: null });
  }
  if (text.startsWith("/") && opts.commands) {
    const r = await runCommand(opts.commands, text);
    if (r) {
      if (r.pending) s.pending = r.pending;
      const question = r.pending ? approvalQuestion(s) : null;
      return finish({ reply: [r.text, question].filter(Boolean).join("\n\n"), text: r.text, question, source: "command", turn: null });
    }
  }
  const before = s.pending;
  const turn = await runTurn(s, llm, text, opts.hooks);
  const question = s.pending && s.pending !== before ? approvalQuestion(s) : null;
  return finish({ reply: question ? `${turn.reply}\n\n${question}` : turn.reply, text: turn.reply, question, source: "llm", turn });
}
