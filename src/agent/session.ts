/** Conversation state for one CLI session. In memory only (Phase 2A: no persistence, no long-term memory). */
import { emptyGoal, type TripGoal } from "../goal/schema.ts";
import type { ChatMessage } from "../llm/types.ts";
import type { TravelSearchProvider } from "../travel/index.ts";
import type { CandidateComparison } from "../compare/engine.ts";

export interface ComparisonSnapshot { at: string; goal: TripGoal; planNote: string | null; disclosures: string[]; results: CandidateComparison[] }

export class Session {
  goal: TripGoal = emptyGoal();
  messages: ChatMessage[] = [];
  searches = new Map<string, unknown>();
  lastComparison: ComparisonSnapshot | null = null;
  turnSearches = 0;
  blocked: string | null = null;
  monitoringNoticeShown = false;
  constructor(readonly provider: TravelSearchProvider, readonly now: () => Date = () => new Date()) {}

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
  }
}
