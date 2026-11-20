/** Conversation state for one CLI session. In memory only (Phase 2A: no persistence, no long-term memory). */
import { emptyGoal, type TripGoal } from "../goal/schema.ts";
import type { ChatMessage } from "../llm/types.ts";
import type { TravelSearchProvider } from "../travel/index.ts";
import type { CandidateComparison } from "../compare/engine.ts";
import type { GoalService } from "../goals/service.ts";
import type { PreferenceStore, StoredPreference } from "../memory/preferences.ts";
import type { Db } from "../db/client.ts";

/** Phase 3 services. Absent = Phase 2 behaviour (no database): monitoring and memory tools are not offered. */
export interface Persistence { db: Db; goals: GoalService; prefs: PreferenceStore; conversationId: number | null }

/** Something only the user can approve. The app (not the LLM) resolves it from the user's next reply. */
export type PendingConfirmation =
  | { kind: "goal"; goalId: number; hash: string; summaryFa: string }
  | { kind: "preference"; key: string; value: unknown; sourceMessageId: number | null };

export interface ComparisonSnapshot { at: string; goal: TripGoal; planNote: string | null; disclosures: string[]; results: CandidateComparison[] }

export class Session {
  goal: TripGoal = emptyGoal();
  messages: ChatMessage[] = [];
  searches = new Map<string, unknown>();
  lastComparison: ComparisonSnapshot | null = null;
  turnSearches = 0;
  blocked: string | null = null;
  monitoringNoticeShown = false;
  pending: PendingConfirmation | null = null;
  preferences: StoredPreference[] = [];
  /** Id of the stored user message of the current turn (for preference provenance). */
  lastUserMessageId: number | null = null;
  constructor(readonly provider: TravelSearchProvider, readonly now: () => Date = () => new Date(),
    readonly userId = "local", readonly persistence: Persistence | null = null) {}

  /** The latest user message (used to cross-check what the LLM reports). */
  lastUserText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) { const m = this.messages[i]!; if (m.role === "user") return m.content; }
    return "";
  }

  goalSummary() {
    const g = this.goal;
    return {
      intent: g.intent, origin: g.origin?.fa ?? g.origin?.input ?? null, destination: g.destination?.fa ?? g.destination?.input ?? null,
      dates: g.dates, adults: g.adults, children: g.children, rooms: g.rooms, budget: g.budget, minimumHotelStars: g.minimumHotelStars,
      preferences: g.preferences, monitoringRequested: g.monitoringRequested, pendingAssumptions: g.pendingAssumptions,
    };
  }
  reset() {
    this.goal = emptyGoal(); this.messages = []; this.searches.clear(); this.lastComparison = null; this.blocked = null; this.monitoringNoticeShown = false;
    this.pending = null;
  }
}
