/** Shapes returned by the local API (src/web/app.ts, src/render/cards.ts, src/web/views.ts). */
export interface FlightCard { airline: string; flightNumbers: string; departFa: string; arriveFa: string; priceFa: string; seatsFa: string }
export interface HotelCard { name: string; starsFa: string | null; nightsFa: string; roomsFa: string; priceFa: string }
export interface OptionCard { rankFa: string; totalToman: number; totalFa: string; withinBudget: boolean | null; outbound: FlightCard | null; return: FlightCard | null; hotel: HotelCard | null; warningsFa: string[] }
export interface CandidateCard { titleFa: string; nightsFa: string; status: "complete" | "incomplete" | "no_match"; staleFa: string | null; reasonsFa: string[]; options: OptionCard[]; notesFa: string[]; sourceFa: string | null }
export interface ComparisonCards { at: string; planNoteFa: string | null; disclosuresFa: string[]; candidates: CandidateCard[]; disclaimerFa: string }
export interface GoalView {
  id: number; idFa: string; name: string; status: string; statusFa: string; summaryFa: string;
  nextCheckFa: string | null; approvedFa: string | null; expiresFa: string | null; totalChecksFa: string;
  lastSuccess: { atFa: string; statusFa: string; totalFa: string | null } | null;
  lastFailure: { atFa: string; reason: string } | null;
  changePendingFa: string | null;
}
export type PendingView = { kind: "goal"; goalId: number; goalIdFa: string; summaryFa: string; change: boolean } | { kind: "preference"; key: string; textFa: string } | null;
export interface ToolEventView { type: string; textFa: string }
export interface StateView {
  userId: string; info: { llm: string; telegram: boolean; db: string } | null; pending: PendingView;
  transcript: { id: number; role: "user" | "assistant"; text: string }[]; resumed: { savedAtFa: string } | null; cards: ComparisonCards | null; goals: GoalView[];
}
