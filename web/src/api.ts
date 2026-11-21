/** Client for the local PEYVA API. fetchFn is injectable so tests can drive the real server in-process. */
import { readSse } from "./sse.ts";
import type { ComparisonCards, GoalView, Snapshot, StateView, ToolEventView, TripFieldKey } from "./types.ts";

export type ChatEvent = { event: string; data: any };
export type Api = ReturnType<typeof createApi>;
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response> | Response;

/** A failed request with the server's own Persian explanation when it gave one. */
export class ApiError extends Error { constructor(message: string, readonly status: number, readonly body: any) { super(message); } }

export function createApi(fetchFn: FetchFn = (input, init) => fetch(input, init)) {
  async function json<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetchFn(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError((data as { errorFa?: string; error?: string }).errorFa ?? (data as { error?: string }).error ?? `HTTP ${res.status}`, res.status, data);
    return data as T;
  }
  return {
    state: () => json<StateView>("/api/state"),
    activity: () => json<{ goals: GoalView[]; unreadAlerts: number }>("/api/activity"),
    approve: (decision: "approve" | "reject", ref: { goalId?: number; key?: string }) =>
      json<Snapshot & { reply: string | null; activityGoalId: number | null }>("/api/approval", { decision, ...ref }),
    goalAction: (id: number, action: "pause" | "resume" | "cancel") => json<{ goal: GoalView; goals: GoalView[] }>(`/api/goals/${id}/${action}`, {}),
    propose: (id: number, change: { budget?: string; stars?: number }) => json<Snapshot & { unchanged?: boolean }>(`/api/goals/${id}/propose`, change),
    editTrip: (field: TripFieldKey | "confirmAssumptions", value: string | number | true) => json<Snapshot & { changeFa: string | null }>("/api/trip", { field, value }),
    compare: () => json<Snapshot & { cards: ComparisonCards; events: ToolEventView[] }>("/api/compare", {}),
    markAlertsRead: () => json<Snapshot>("/api/notifications/read", {}),
    reset: () => json<{ ok: true }>("/api/reset", {}),
    async chat(text: string, onEvent: (e: ChatEvent) => void): Promise<void> {
      const res = await fetchFn("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError((data as { errorFa?: string; error?: string }).errorFa ?? (data as { error?: string }).error ?? `HTTP ${res.status}`, res.status, data);
      }
      for await (const m of readSse(res.body)) onEvent({ event: m.event, data: JSON.parse(m.data) });
    },
  };
}
