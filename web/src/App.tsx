import { useCallback, useEffect, useReducer, useState } from "react";
import type { Api, ChatEvent } from "./api.ts";
import type { ComparisonCards, GoalView, Snapshot, StateView, TripFieldKey } from "./types.ts";
import { ResultTickets } from "./ui/Results.tsx";
import { Brief } from "./ui/Brief.tsx";
import { Activities, GoalCard, type GoalActions } from "./ui/Activities.tsx";
import { ApprovalPanel } from "./ui/Approval.tsx";

interface Step { key: string; labelFa: string; status: "running" | "ok" | "failed"; details: string[]; count: number }
export interface Msg {
  id: string; role: "user" | "assistant"; text: string; live: string; streaming: boolean; steps: Step[]; cards: ComparisonCards | null;
  warnings: string[]; error: string | null;
  /** An action done with the app's own controls (edit, approval click), shown as a quiet note. */
  note: boolean;
  /** Approval reply about this goal: the live goal card is shown with it. */
  activityGoalId: number | null;
}
const EMPTY_SNAP: Snapshot = { pending: null, trip: { empty: true, ready: false, fields: [], missingFa: [], conflictsFa: [], assumptionsFa: [], results: "none", monitoredBy: null }, goals: [], unreadAlerts: 0 };
interface State { msgs: Msg[]; snap: Snapshot; info: StateView["info"]; resumed: StateView["resumed"]; busy: boolean; loaded: boolean; loadError: string | null }

const TOOL_FA: Record<string, string> = {
  update_trip_goal: "ثبت جزئیات سفر", compare_trip_options: "مقایسهٔ گزینه‌ها", start_monitoring: "آماده‌کردن شرایط پیگیری",
  propose_preference: "پیشنهاد ذخیرهٔ ترجیح", search_flights: "جست‌وجوی پرواز", search_hotels: "جست‌وجوی هتل",
};
let seq = 0;
const newMsg = (role: Msg["role"], text = "", o: Partial<Msg> = {}): Msg =>
  ({ id: `m${++seq}`, role, text, live: "", streaming: false, steps: [], cards: null, warnings: [], error: null, note: false, activityGoalId: null, ...o });
const isNote = (t: string) => t.startsWith("✎") || t === "(دکمهٔ تأیید)" || t === "(دکمهٔ رد)";

type Action =
  | { t: "loaded"; s: StateView } | { t: "load_failed"; error: string } | { t: "send"; text: string } | { t: "event"; e: ChatEvent }
  | { t: "fail"; error: string } | { t: "end" } | { t: "snap"; s: Partial<Snapshot> } | { t: "push"; m: Msg } | { t: "reset" };

function patchLast(s: State, f: (m: Msg) => Msg): State {
  const msgs = s.msgs.slice();
  const i = msgs.length - 1;
  if (i >= 0 && msgs[i]!.role === "assistant") msgs[i] = f(msgs[i]!);
  return { ...s, msgs };
}

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case "loaded": {
      const msgs = a.s.transcript.map((m) => newMsg(m.role, m.text, { note: m.role === "user" && isNote(m.text) }));
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      if (last && a.s.cards) last.cards = a.s.cards;
      const { pending, trip, goals, unreadAlerts } = a.s;
      return { ...s, msgs, snap: { pending, trip, goals, unreadAlerts }, info: a.s.info, resumed: a.s.resumed, loaded: true, loadError: null };
    }
    case "load_failed": return { ...s, loaded: true, loadError: a.error };
    case "send": return { ...s, busy: true, msgs: [...s.msgs, newMsg("user", a.text), newMsg("assistant", "", { streaming: true })] };
    case "event": {
      const { event, data } = a.e;
      if (event === "llm") return patchLast(s, (m) => ({ ...m, live: "" }));
      if (event === "delta") return patchLast(s, (m) => ({ ...m, live: m.live + data.text }));
      if (event === "tool_start") return patchLast(s, (m) => {
        const labelFa = TOOL_FA[data.name] ?? data.name;
        const prev = m.steps.at(-1);
        // The same step repeated (e.g. the goal recorded in two calls) is shown once, not as a list of duplicates.
        if (prev && prev.labelFa === labelFa && prev.status !== "running") return { ...m, live: "", steps: [...m.steps.slice(0, -1), { ...prev, status: "running", count: prev.count + 1 }] };
        return { ...m, live: "", steps: [...m.steps, { key: `${data.name}${m.steps.length}`, labelFa, status: "running", details: [], count: 1 }] };
      });
      if (event === "tool_done") return patchLast(s, (m) => {
        const steps = m.steps.slice();
        const i = steps.findLastIndex((x) => x.status === "running");
        if (i >= 0) steps[i] = { ...steps[i]!, status: data.ok || steps[i]!.status === "ok" ? "ok" : "failed",
          details: [...steps[i]!.details, ...(data.events as { type: string; textFa: string }[]).filter((e) => e.type !== "goal_updated").map((e) => e.textFa)] };
        return { ...m, steps };
      });
      if (event === "cards") return patchLast(s, (m) => ({ ...m, cards: data }));
      if (event === "reply") return patchLast(s, (m) => (data.llmError ? { ...m, text: "", live: "", error: data.text, warnings: data.warnings ?? [] }
        : { ...m, text: data.text, live: "", warnings: data.warnings ?? [], activityGoalId: data.activityGoalId ?? null }));
      if (event === "state") { const { pending, trip, goals, unreadAlerts } = data; return { ...s, snap: { pending, trip, goals, unreadAlerts } }; }
      if (event === "error") return patchLast(s, (m) => ({ ...m, error: data.message }));
      return s;
    }
    case "fail": return patchLast({ ...s, busy: false }, (m) => ({ ...m, streaming: false, error: a.error }));
    case "end": return patchLast({ ...s, busy: false }, (m) => ({ ...m, streaming: false }));
    case "snap": return { ...s, snap: { ...s.snap, ...a.s } };
    case "push": return { ...s, msgs: [...s.msgs, a.m] };
    case "reset": return { ...s, msgs: [], snap: { ...s.snap, pending: null, trip: EMPTY_SNAP.trip }, resumed: null, busy: false };
  }
}

const EXAMPLES = ["یه سفر سه‌شبه از تهران به کیش می‌خوام، ۱۹ آذر، یک نفر، زیر ۳۰ میلیون", "بهمن دو نفری بریم مشهد، هتل چهار ستاره"];

function Steps({ steps, done }: { steps: Step[]; done: boolean }) {
  if (!steps.length) return null;
  const searches = steps.reduce((n, s) => n + s.details.filter((d) => d.startsWith("🔎")).length, 0);
  const list = (
    <ul className="space-y-1 text-sm text-ink-soft">
      {steps.map((st) => (
        <li key={st.key}>
          <span aria-hidden className={st.status === "failed" ? "text-anar" : st.status === "ok" ? "text-firouzeh" : ""}>{st.status === "running" ? "◌" : st.status === "ok" ? "✓" : "✕"}</span>{" "}
          {st.labelFa}{st.status === "running" ? "…" : ""}
          {st.details.length ? <ul className="ms-5">{st.details.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
        </li>
      ))}
    </ul>
  );
  if (!done) return <div className="mb-2" aria-label="کارهای در حال انجام">{list}</div>;
  return (
    <details className="mb-2 text-sm text-ink-soft" aria-label="کارهای انجام‌شده">
      <summary className="cursor-pointer select-none">✓ {steps.map((s) => s.labelFa).join("، ")}{searches ? ` · ${searches.toLocaleString("fa-IR")} جست‌وجوی واقعی` : ""}</summary>
      <div className="mt-1">{list}</div>
    </details>
  );
}

function Message({ m, goals, actions }: { m: Msg; goals: GoalView[]; actions: GoalActions }) {
  if (m.note) return <p dir="auto" className="text-center text-xs text-ink-soft">{m.text.replace(/^✎\s*/, "تغییر دادی: ")}</p>;
  if (m.role === "user") return <div className="flex justify-end"><p dir="auto" className="max-w-[85%] whitespace-pre-line rounded-2xl bg-firouzeh-wash px-4 py-2.5 leading-8">{m.text}</p></div>;
  const text = m.text || m.live;
  const goal = m.activityGoalId ? goals.find((g) => g.id === m.activityGoalId) : undefined;
  return (
    <article className="leading-8" aria-busy={m.streaming}>
      <Steps steps={m.steps} done={!m.streaming} />
      {/* The comparison comes first: the agent's text refers to it ("the table above"), as in the terminal. */}
      {m.cards ? <div className="mb-4"><ResultTickets cards={m.cards} /></div> : null}
      {text ? <p className={`whitespace-pre-line ${m.streaming && !m.text ? "caret" : ""}`}>{text}</p>
        : m.streaming ? <p className="caret text-ink-soft">{m.steps.length ? "" : "پیوا دارد فکر می‌کند"}</p> : null}
      {goal ? <div className="mt-3 rounded-xl border border-line bg-paper p-4"><GoalCard g={goal} actions={actions} compact /></div> : null}
      {m.warnings.map((w) => <p key={w} className="mt-2 border-s-4 border-saffron ps-3 text-sm">{w}</p>)}
      {m.error ? <p role="alert" className="mt-2 border-s-4 border-anar ps-3 text-sm">{m.error}</p> : null}
    </article>
  );
}

export function App({ api }: { api: Api }) {
  const [s, dispatch] = useReducer(reducer, { msgs: [], snap: EMPTY_SNAP, info: null, resumed: null, busy: false, loaded: false, loadError: null });
  const [draft, setDraft] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [showActivities, setShowActivities] = useState(false);

  useEffect(() => { api.state().then((st) => dispatch({ t: "loaded", s: st }), (e: Error) => dispatch({ t: "load_failed", error: e.message })); }, [api]);
  // New messages and a newly shown approval panel scroll into view (the sticky composer would otherwise cover them).
  useEffect(() => { if (s.msgs.length || s.snap.pending) window.scrollTo?.({ top: document.documentElement.scrollHeight }); }, [s.msgs, s.snap.pending]);
  // Persistent activities change on their own (the worker): refresh from PostgreSQL while the page is visible.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "visible" || s.busy) return;
      api.activity().then((a) => dispatch({ t: "snap", s: a }), () => {});
    }, 60_000);
    return () => clearInterval(id);
  }, [api, s.busy]);

  const busy = s.busy || actionBusy;
  const run = useCallback(async <T,>(f: () => Promise<T>): Promise<T | null> => {
    setActionBusy(true);
    try { return await f(); } finally { setActionBusy(false); }
  }, []);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setDraft("");
    dispatch({ t: "send", text: t });
    try { await api.chat(t, (e) => dispatch({ t: "event", e })); dispatch({ t: "end" }); }
    catch (e) { dispatch({ t: "fail", error: `ارتباط با سرور پیوا قطع شد: ${(e as Error).message}` }); }
  }
  async function decide(approve: boolean) {
    const p = s.snap.pending;
    if (!p) return;
    await run(async () => {
      try {
        const r = await api.approve(approve ? "approve" : "reject", p.kind === "goal" ? { goalId: p.goalId } : { key: p.key });
        dispatch({ t: "snap", s: r });
        dispatch({ t: "push", m: newMsg("user", approve ? "(دکمهٔ تأیید)" : "(دکمهٔ رد)", { note: true }) });
        if (r.reply) dispatch({ t: "push", m: newMsg("assistant", r.reply, { activityGoalId: approve && p.kind === "goal" ? r.activityGoalId : null }) });
        setAnnounce(r.reply ?? "");
      } catch (e) {
        const st = await api.state().catch(() => null);
        if (st) dispatch({ t: "snap", s: st });
        dispatch({ t: "push", m: newMsg("assistant", "", { error: `انجام نشد: ${(e as Error).message}` }) });
      }
    });
  }
  async function editTrip(field: TripFieldKey | "confirmAssumptions", value: string | number | true): Promise<string | null> {
    const r = await run(async () => {
      try { const x = await api.editTrip(field, value); dispatch({ t: "snap", s: x }); dispatch({ t: "push", m: newMsg("user", `✎ ${x.changeFa}`, { note: true }) }); setAnnounce(x.changeFa); return null; }
      catch (e) { return (e as Error).message; }
    });
    return r ?? null;
  }
  async function compare() {
    setChecking(true);
    try {
      const r = await api.compare();
      dispatch({ t: "snap", s: r });
      dispatch({ t: "push", m: newMsg("assistant", "نتایج با شرایط فعلی دوباره بررسی شد.", { cards: r.cards,
        steps: [{ key: "cmp", labelFa: "مقایسهٔ گزینه‌ها", status: "ok", count: 1, details: r.events.map((e) => e.textFa) }] }) });
      setAnnounce("نتایج تازه آماده شد.");
    } catch (e) {
      dispatch({ t: "push", m: newMsg("assistant", "", { error: `جست‌وجو انجام نشد: ${(e as Error).message}` }) });
    } finally { setChecking(false); }
  }
  const actions: GoalActions = {
    busy,
    onAction: async (id, a) => {
      await run(async () => {
        try { const r = await api.goalAction(id, a); dispatch({ t: "snap", s: { goals: r.goals } }); setAnnounce(`پیگیری #${id.toLocaleString("fa-IR")}: ${r.goal.statusFa}`); }
        catch (e) { setAnnounce(`انجام نشد: ${(e as Error).message}`); dispatch({ t: "snap", s: { goals: (await api.activity()).goals } }); }
      });
    },
    onPropose: async (id, change) => (await run(async () => {
      try { const r = await api.propose(id, change); dispatch({ t: "snap", s: r }); setAnnounce(r.unchanged ? "چیزی تغییر نکرد." : "تغییر پیشنهادی آماده است؛ تأییدش کن یا نه."); return null; }
      catch (e) { return (e as Error).message; }
    })) ?? null,
    onReadAlert: () => { void api.markAlertsRead().then((r) => dispatch({ t: "snap", s: r }), () => {}); },
  };
  async function reset() { await api.reset(); dispatch({ t: "reset" }); }

  const activeCount = s.snap.goals.filter((g) => g.status === "active").length;
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl gap-8 px-4 lg:px-8">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 py-4">
          <div className="flex items-baseline gap-3">
            <h1 className="font-display text-4xl leading-none text-firouzeh-deep">پیوا</h1>
            <p className="hidden text-sm text-ink-soft sm:block">دستیار شخصی‌ات برای خدمات آنلاین؛ فعلاً سفر</p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setShowActivities(!showActivities)} aria-expanded={showActivities} aria-controls="activities-mobile"
              className="relative min-h-10 rounded-md px-3 text-sm text-lapis hover:bg-paper lg:hidden">
              پیگیری‌ها ({activeCount.toLocaleString("fa-IR")})
              {s.snap.unreadAlerts ? <span className="absolute end-1 top-1 size-2 rounded-full bg-saffron" aria-label="اعلان تازه" /> : null}
            </button>
            <button type="button" onClick={reset} disabled={busy} className="min-h-10 rounded-md px-3 text-sm text-lapis hover:bg-paper disabled:opacity-50">گفتگوی تازه</button>
          </div>
        </header>
        {showActivities ? (
          <section id="activities-mobile" aria-label="کارهای در جریان پیوا" className="mb-4 rounded-xl border border-line bg-paper p-4 lg:hidden">
            <Activities goals={s.snap.goals} actions={actions} />
          </section>
        ) : null}
        <main className="flex-1 space-y-6 pb-6">
          {s.loadError ? <p role="alert" className="border-s-4 border-anar ps-3">سرور پیوا در دسترس نیست ({s.loadError}). آن را با <bdi dir="ltr">bun run peyva:web</bdi> اجرا کن.</p> : null}
          {s.loaded && !s.msgs.length && !s.loadError ? (
            <div className="pt-8">
              <p className="max-w-[58ch] text-lg leading-9">بگو کجا می‌خواهی بروی. پیوا پرواز و هتل را در MrBilit جست‌وجو می‌کند، جمع هزینه را دقیق حساب می‌کند و اگر بخواهی، قیمت را برایت زیر نظر می‌گیرد.</p>
              <div className="mt-5 flex flex-wrap gap-2">
                {EXAMPLES.map((x) => <button key={x} type="button" onClick={() => setDraft(x)} className="min-h-10 rounded-full border border-line bg-paper px-4 text-sm hover:border-firouzeh">{x}</button>)}
              </div>
            </div>
          ) : null}
          {s.resumed && s.msgs.length ? <p className="text-sm text-ink-soft">این گفتگو پس از راه‌اندازی دوبارهٔ سرور از پایگاه داده ادامه یافت (آخرین ذخیره: {s.resumed.savedAtFa}).</p> : null}
          {s.msgs.map((m) => <Message key={m.id} m={m} goals={s.snap.goals} actions={actions} />)}
          {s.snap.pending ? <ApprovalPanel pending={s.snap.pending} busy={busy} onDecide={decide} /> : null}
        </main>
        <div className="sticky bottom-0 bg-mist pb-4 pt-1">
          <Brief trip={s.snap.trip} busy={busy} checking={checking} onEdit={editTrip} onCompare={() => void compare()} />
          <form onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
            <label htmlFor="composer" className="sr-only">پیام به پیوا</label>
            <div className="flex items-end gap-2 rounded-xl border border-line bg-paper p-2 focus-within:border-firouzeh">
              <textarea id="composer" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
                placeholder="مثلاً: سفر سه‌شبه به کیش، یک نفر، زیر ۳۰ میلیون" className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1.5 leading-7 outline-none" />
              <button type="submit" disabled={busy || !draft.trim()} className="min-h-11 rounded-lg bg-firouzeh px-5 font-medium text-white hover:bg-firouzeh-deep disabled:opacity-40">
                {s.busy ? "…" : "بفرست"}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-ink-soft">پیوا فقط جست‌وجو و مقایسه می‌کند؛ رزرو و پرداخت با خودت است.</p>
          </form>
        </div>
        <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      </div>
      <aside className="sticky top-0 hidden h-dvh w-80 shrink-0 overflow-y-auto border-s border-line py-6 ps-6 lg:block" aria-label="کارهای در جریان پیوا">
        <h2 className="mb-1 font-bold">کارهای در جریان پیوا</h2>
        <p className="mb-4 text-xs text-ink-soft">{s.snap.unreadAlerts ? `${s.snap.unreadAlerts.toLocaleString("fa-IR")} اعلان تازه` : "آنچه پیوا برایت زیر نظر دارد"}</p>
        <Activities goals={s.snap.goals} actions={actions} />
      </aside>
    </div>
  );
}
