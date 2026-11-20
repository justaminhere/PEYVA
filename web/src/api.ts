/** Client for the local PEYVA API. fetchFn is injectable so tests can drive the real server in-process. */
import { readSse } from "./sse.ts";
import type { GoalView, PendingView, StateView } from "./types.ts";

export type ChatEvent = { event: string; data: any };
export type Api = ReturnType<typeof createApi>;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response> | Response;

export function createApi(fetchFn: FetchFn = (input, init) => fetch(input, init)) {
  async function json<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetchFn(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data as T;
  }
  return {
    state: () => json<StateView>("/api/state"),
    goals: () => json<{ goals: GoalView[] }>("/api/goals"),
    approve: (decision: "approve" | "reject", ref: { goalId?: number; key?: string }) =>
      json<{ reply: string | null; pending: PendingView; goals: GoalView[] }>("/api/approval", { decision, ...ref }),
    goalAction: (id: number, action: "pause" | "resume" | "cancel") => json<{ goal: GoalView; goals: GoalView[] }>(`/api/goals/${id}/${action}`, {}),
    reset: () => json<{ ok: true }>("/api/reset", {}),
    async chat(text: string, onEvent: (e: ChatEvent) => void): Promise<void> {
      const res = await fetchFn("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      for await (const m of readSse(res.body)) onEvent({ event: m.event, data: JSON.parse(m.data) });
    },
  };
}
