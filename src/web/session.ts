/** Creates the web app's agent session: resumes the latest conversation after a restart (once), else starts a new one. */
import { Session, type Persistence } from "../agent/session.ts";
import type { TravelSearchProvider } from "../travel/index.ts";
import type { ConversationStore } from "../memory/conversations.ts";
import { resumeLatest, type ResumeOutcome } from "../memory/session-state.ts";

export interface SessionFactoryDeps {
  provider: TravelSearchProvider;
  userId: string;
  persistence: Omit<Persistence, "conversationId">;
  store: ConversationStore;
  now?: () => Date;
  /** Resume only conversations saved within this window (default 24 h). 0 disables resuming. */
  resumeMaxAgeMs?: number;
  onResume?: (o: ResumeOutcome) => void;
}

export function webSessionFactory(d: SessionFactoryDeps) {
  const now = d.now ?? (() => new Date());
  let first = true;
  return async (): Promise<Session> => {
    const s = new Session(d.provider, now, d.userId, { ...d.persistence, conversationId: null });
    s.preferences = await d.persistence.prefs.list(d.userId);
    const tryResume = first && (d.resumeMaxAgeMs ?? 24 * 3_600_000) > 0;
    first = false; // "گفتگوی تازه" (reset) always starts a new conversation
    if (tryResume) {
      const o = await resumeLatest(s, d.store, { maxAgeMs: d.resumeMaxAgeMs ?? 24 * 3_600_000 });
      d.onResume?.(o);
      if (o.resumed) return s;
    }
    s.persistence = { ...d.persistence, conversationId: await d.store.start(d.userId, now()) };
    return s;
  };
}
