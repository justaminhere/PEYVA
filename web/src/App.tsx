import { useEffect, useReducer, useRef, useState } from "react";
import type { Api, ChatEvent } from "./api.ts";
import type { ComparisonCards, GoalView, PendingView, StateView } from "./types.ts";
import { ApprovalPanel, GoalsPanel, ResultTickets, Wordmark } from "./components.tsx";

interface Step { key: string; labelFa: string; status: "running" | "ok" | "failed"; details: string[] }
export interface Msg { id: string; role: "user" | "assistant"; text: string; live: string; streaming: boolean; steps: Step[]; cards: ComparisonCards | null; warnings: string[]; error: string | null }
interface State { msgs: Msg[]; pending: PendingView; goals: GoalView[]; info: StateView["info"]; busy: boolean; loaded: boolean; loadError: string | null }

const TOOL_FA: Record<string, string> = {
  update_trip_goal: "ثبت جزئیات سفر", compare_trip_options: "مقایسهٔ گزینه‌ها", start_monitoring: "ساخت پیش‌نویس پیگیری",
  propose_preference: "پیشنهاد ذخیرهٔ ترجیح", search_flights: "جست‌وجوی پرواز", search_hotels: "جست‌وجوی هتل",
};
let seq = 0;
const newMsg = (role: Msg["role"], text = "", streaming = false): Msg => ({ id: `m${++seq}`, role, text, live: "", streaming, steps: [], cards: null, warnings: [], error: null });

type Action =
  | { t: "loaded"; s: StateView } | { t: "load_failed"; error: string } | { t: "send"; text: string } | { t: "event"; e: ChatEvent }
  | { t: "fail"; error: string } | { t: "end" } | { t: "approval"; reply: string | null; pending: PendingView; goals: GoalView[] }
  | { t: "goals"; goals: GoalView[] } | { t: "busy"; busy: boolean } | { t: "reset" };

function patchLast(s: State, f: (m: Msg) => Msg): State {
  const msgs = s.msgs.slice();
  const i = msgs.length - 1;
  if (i >= 0 && msgs[i]!.role === "assistant") msgs[i] = f(msgs[i]!);
  return { ...s, msgs };
}

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case "loaded": {
      const msgs = a.s.transcript.map((m) => ({ ...newMsg(m.role, m.text) }));
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      if (last && a.s.cards) last.cards = a.s.cards;
      return { ...s, msgs, pending: a.s.pending, goals: a.s.goals, info: a.s.info, loaded: true, loadError: null };
    }
    case "load_failed": return { ...s, loaded: true, loadError: a.error };
    case "send": return { ...s, busy: true, msgs: [...s.msgs, newMsg("user", a.text), newMsg("assistant", "", true)] };
    case "event": {
      const { event, data } = a.e;
      if (event === "llm") return patchLast(s, (m) => ({ ...m, live: "" }));
      if (event === "delta") return patchLast(s, (m) => ({ ...m, live: m.live + data.text }));
      if (event === "tool_start") return patchLast(s, (m) => ({ ...m, live: "", steps: [...m.steps, { key: `${data.name}${m.steps.length}`, labelFa: TOOL_FA[data.name] ?? data.name, status: "running", details: [] }] }));
      if (event === "tool_done") return patchLast(s, (m) => {
        const steps = m.steps.slice();
        for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.status === "running") {
          steps[i] = { ...steps[i]!, status: data.ok ? "ok" : "failed", details: (data.events as { type: string; textFa: string }[]).filter((e) => e.type !== "goal_updated").map((e) => e.textFa) };
          break;
        }
        return { ...m, steps };
      });
      if (event === "cards") return patchLast(s, (m) => ({ ...m, cards: data }));
      if (event === "reply") return patchLast(s, (m) => ({ ...m, text: data.text, live: "", warnings: data.warnings ?? [] }));
      if (event === "state") return { ...s, pending: data.pending, goals: data.goals };
      if (event === "error") return patchLast(s, (m) => ({ ...m, error: data.message }));
      return s;
    }
    case "fail": return patchLast({ ...s, busy: false }, (m) => ({ ...m, streaming: false, error: a.error }));
    case "end": return patchLast({ ...s, busy: false }, (m) => ({ ...m, streaming: false }));
    case "approval": return { ...s, pending: a.pending, goals: a.goals, busy: false, msgs: a.reply ? [...s.msgs, newMsg("assistant", a.reply)] : s.msgs };
    case "goals": return { ...s, goals: a.goals, busy: false };
    case "busy": return { ...s, busy: a.busy };
    case "reset": return { ...s, msgs: [], pending: null, busy: false };
  }
}

const EXAMPLES = [
  "یه سفر سه‌شبه از تهران به کیش می‌خوام، ۱۹ آذر، یک نفر، زیر ۳۰ میلیون",
  "بهمن دو نفری بریم مشهد، هتل چهار ستاره",
];

function Message({ m }: { m: Msg }) {
  if (m.role === "user") return <div className="flex justify-end"><p className="max-w-[85%] whitespace-pre-line rounded-2xl bg-firouzeh-wash px-4 py-2.5 leading-8">{m.text}</p></div>;
  const text = m.text || m.live;
  return (
    <article className="leading-8" aria-busy={m.streaming}>
      {m.steps.length ? (
        <ul className="mb-2 space-y-1 text-sm text-ink-soft" aria-label="کارهای انجام‌شده">
          {m.steps.map((st) => (
            <li key={st.key}>
              <span aria-hidden className={st.status === "failed" ? "text-anar" : st.status === "ok" ? "text-firouzeh" : ""}>{st.status === "running" ? "◌" : st.status === "ok" ? "✓" : "✕"}</span> {st.labelFa}{st.status === "running" ? "…" : ""}
              {st.details.length ? <ul className="ms-5">{st.details.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {text ? <p className={`whitespace-pre-line ${m.streaming && !m.text ? "caret" : ""}`}>{text}</p>
        : m.streaming ? <p className="caret text-ink-soft">پیوا در حال کار است</p> : null}
      {m.cards ? <ResultTickets cards={m.cards} /> : null}
      {m.warnings.map((w) => <p key={w} className="mt-2 border-s-4 border-saffron ps-3 text-sm">{w}</p>)}
      {m.error ? <p role="alert" className="mt-2 border-s-4 border-anar ps-3 text-sm">{m.error}</p> : null}
    </article>
  );
}

export function App({ api }: { api: Api }) {
  const [s, dispatch] = useReducer(reducer, { msgs: [], pending: null, goals: [], info: null, busy: false, loaded: false, loadError: null });
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { api.state().then((st) => dispatch({ t: "loaded", s: st }), (e: Error) => dispatch({ t: "load_failed", error: e.message })); }, [api]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [s.msgs]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || s.busy) return;
    setDraft("");
    dispatch({ t: "send", text: t });
    try { await api.chat(t, (e) => dispatch({ t: "event", e })); dispatch({ t: "end" }); }
    catch (e) { dispatch({ t: "fail", error: `ارتباط با سرور پیوا قطع شد: ${(e as Error).message}` }); }
  }
  async function decide(approve: boolean) {
    if (!s.pending) return;
    dispatch({ t: "busy", busy: true });
    try {
      const r = await api.approve(approve ? "approve" : "reject", s.pending.kind === "goal" ? { goalId: s.pending.goalId } : { key: s.pending.key });
      dispatch({ t: "approval", reply: r.reply, pending: r.pending, goals: r.goals });
    } catch (e) {
      dispatch({ t: "busy", busy: false });
      const st = await api.state().catch(() => null);
      if (st) dispatch({ t: "loaded", s: st });
      dispatch({ t: "approval", reply: `انجام نشد: ${(e as Error).message}`, pending: st?.pending ?? null, goals: st?.goals ?? s.goals });
    }
  }
  async function goalAction(id: number, a: "pause" | "resume" | "cancel") {
    dispatch({ t: "busy", busy: true });
    try { dispatch({ t: "goals", goals: (await api.goalAction(id, a)).goals }); }
    catch { dispatch({ t: "goals", goals: (await api.goals()).goals }); }
  }
  async function reset() { await api.reset(); dispatch({ t: "reset" }); }

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl gap-8 px-4 lg:px-8">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between py-5">
          <Wordmark info={s.info} />
          <button type="button" onClick={reset} disabled={s.busy} className="text-sm text-lapis hover:underline disabled:opacity-50">گفتگوی تازه</button>
        </header>
        <main className="flex-1 space-y-6 pb-6" aria-live="polite">
          {s.loadError ? <p role="alert" className="border-s-4 border-anar ps-3">سرور پیوا در دسترس نیست ({s.loadError}). آن را با <span className="ltr">bun run peyva:web</span> اجرا کن.</p> : null}
          {s.loaded && !s.msgs.length && !s.loadError ? (
            <div className="pt-10">
              <p className="max-w-[60ch] text-lg leading-9">بگو کجا می‌خواهی بروی. پیوا پرواز و هتل را در MrBilit جست‌وجو می‌کند، جمع هزینه را دقیق حساب می‌کند و اگر بخواهی، قیمت را برایت زیر نظر می‌گیرد.</p>
              <div className="mt-5 flex flex-wrap gap-2">
                {EXAMPLES.map((x) => <button key={x} type="button" onClick={() => setDraft(x)} className="rounded-full border border-line bg-paper px-4 py-2 text-sm hover:border-firouzeh">{x}</button>)}
              </div>
            </div>
          ) : null}
          {s.msgs.map((m) => <Message key={m.id} m={m} />)}
          {s.pending ? <ApprovalPanel pending={s.pending} busy={s.busy} onDecide={decide} /> : null}
          <div ref={end} />
        </main>
        <details className="mb-3 rounded-lg border border-line bg-paper px-4 py-2 lg:hidden">
          <summary className="cursor-pointer text-sm">هدف‌های پیگیری ({s.goals.length.toLocaleString("fa-IR")})</summary>
          <div className="py-3"><GoalsPanel goals={s.goals} busy={s.busy} onAction={goalAction} /></div>
        </details>
        <form className="sticky bottom-0 bg-mist pb-5" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
          <label htmlFor="composer" className="sr-only">پیام به پیوا</label>
          <div className="flex items-end gap-2 rounded-xl border border-line bg-paper p-2 focus-within:border-firouzeh">
            <textarea id="composer" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
              placeholder="مثلاً: سفر سه‌شبه به کیش، یک نفر، زیر ۳۰ میلیون" className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1.5 leading-7 outline-none" />
            <button type="submit" disabled={s.busy || !draft.trim()} className="rounded-lg bg-firouzeh px-5 py-2.5 font-medium text-white hover:bg-firouzeh-deep disabled:opacity-40">بفرست</button>
          </div>
          <p className="mt-2 text-xs text-ink-soft">پیوا فقط جست‌وجو و مقایسه می‌کند؛ رزرو و پرداخت با خودت است.</p>
        </form>
      </div>
      <aside className="sticky top-0 hidden h-dvh w-72 shrink-0 overflow-y-auto border-s border-line py-6 ps-6 lg:block" aria-label="هدف‌های پیگیری">
        <h2 className="mb-4 font-bold">هدف‌های پیگیری</h2>
        <GoalsPanel goals={s.goals} busy={s.busy} onAction={goalAction} />
      </aside>
    </div>
  );
}
