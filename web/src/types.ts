/** Shapes returned by the local API (src/web/app.ts, src/web/trip.ts, src/render/cards.ts, src/web/views.ts). */
export interface FlightCard { airline: string; flightNumbers: string; departFa: string; arriveFa: string; priceFa: string; seatsFa: string }
export interface HotelCard { name: string; starsFa: string | null; nightsFa: string; roomsFa: string; priceFa: string }
export interface OptionCard { rankFa: string; totalToman: number; totalFa: string; withinBudget: boolean | null; outbound: FlightCard | null; return: FlightCard | null; hotel: HotelCard | null; warningsFa: string[]; matchFa: string[] }
export interface CandidateCard {
  titleFa: string; nightsFa: string; status: "complete" | "incomplete" | "no_match"; statusFa: string; staleFa: string | null; reasonsFa: string[]; options: OptionCard[]; notesFa: string[]; sourceFa: string | null;
  sharedFlights: { outbound: FlightCard | null; return: FlightCard | null } | null; cheapestTotalFa: string | null; cheapestWithinBudget: boolean | null; fresh: boolean; checkedFa: string | null;
}
export interface ComparisonCards { at: string; planNoteFa: string | null; disclosuresFa: string[]; candidates: CandidateCard[]; disclaimerFa: string; bestIndex: number | null }
export interface GoalView {
  id: number; idFa: string; name: string; status: string; statusFa: string; summaryFa: string;
  nextCheckFa: string | null; approvedFa: string | null; expiresFa: string | null; totalChecksFa: string;
  lastSuccess: { atFa: string; statusFa: string; totalFa: string | null } | null;
  lastFailure: { atFa: string; reason: string } | null;
  changePendingFa: string | null;
  lastAlert: { id: number; atFa: string; totalFa: string | null; unread: boolean; telegramFa: string | null; textFa: string } | null;
  editable: { budgetToman: number | null; minimumHotelStars: number | null } | null;
}
export interface DiffLine { labelFa: string; beforeFa: string; afterFa: string }
export type PendingView =
  | { kind: "goal"; goalId: number; goalIdFa: string; summaryFa: string; change: boolean; diff: DiffLine[] }
  | { kind: "preference"; key: string; textFa: string } | null;
export type TripFieldKey = "origin" | "destination" | "dates" | "nights" | "travellers" | "budget" | "stars";
export interface TripField { key: TripFieldKey; labelFa: string; valueFa: string | null; missing: boolean; input: { type: "text" | "number" | "stars"; value: string; min?: number; max?: number; placeholderFa: string } }
export interface TripView {
  empty: boolean; ready: boolean; fields: TripField[]; missingFa: string[]; conflictsFa: string[]; assumptionsFa: string[];
  results: "none" | "current" | "outdated"; monitoredBy: { goalId: number; goalIdFa: string; status: string } | null;
}
/** What every action returns: the parts of the screen that may have changed, from the server. */
export interface Snapshot { pending: PendingView; trip: TripView; goals: GoalView[]; unreadAlerts: number }
export interface StateView extends Snapshot {
  userId: string; info: { llm: string; telegram: boolean; db: string } | null;
  transcript: { id: number; role: "user" | "assistant"; text: string }[]; resumed: { savedAtFa: string } | null; cards: ComparisonCards | null;
}
export interface ToolEventView { type: string; textFa: string }
