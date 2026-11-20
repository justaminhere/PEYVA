/**
 * Single-user educational mode: one agent session per server process, used by one person in one browser.
 * Requests are serialized so two tabs (or a double click) can never run two turns on the same session at once.
 */
import type { Session } from "../agent/session.ts";

export class AgentHost {
  private chain: Promise<unknown> = Promise.resolve();
  private current: Promise<Session>;
  constructor(private make: () => Promise<Session>) { this.current = make(); }
  /** Runs fn with exclusive access to the session. */
  run<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => fn(await this.current));
    this.chain = next.catch(() => {});
    return next;
  }
  /** Starts a new session (new conversation row); the old one is dropped after running work finishes. */
  reset(): Promise<void> { return this.run(async () => { this.current = this.make(); await this.current; }); }
}
