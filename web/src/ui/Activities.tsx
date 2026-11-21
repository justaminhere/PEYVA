/** The agent's persistent activities (monitoring goals), as stored in PostgreSQL. Shown in context and in the activities list. */
import { useState } from "react";
import type { GoalView } from "../types.ts";

const TONE: Record<string, string> = { active: "bg-firouzeh-wash text-firouzeh-deep", paused: "bg-amber-50 text-amber-800", draft: "bg-mist text-ink-soft" };

export interface GoalActions {
  busy: boolean;
  onAction: (id: number, a: "pause" | "resume" | "cancel") => Promise<void>;
  onPropose: (id: number, change: { budget?: string; stars?: number }) => Promise<string | null>;
  onReadAlert: () => void;
}

export function GoalCard({ g, actions, compact = false }: { g: GoalView; actions: GoalActions; compact?: boolean }) {
  const [mode, setMode] = useState<"idle" | "edit" | "confirmCancel">("idle");
  const [showAlert, setShowAlert] = useState(false);
  const live = g.status === "active" || g.status === "paused";
  return (
    <article data-testid="goal" aria-label={`هدف ${g.idFa}: ${g.name}`} className={compact ? "" : "border-b border-line pb-4 last:border-0"}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium leading-7"><span className="text-ink-soft">#{g.idFa}</span> {g.name}</h3>
        <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${TONE[g.status] ?? "bg-mist"}`}>{g.statusFa}</span>
      </div>
      <dl className="mt-1 space-y-0.5 text-sm text-ink-soft">
        {g.nextCheckFa ? <div><dt className="inline">بررسی بعدی: </dt><dd className="inline">{g.nextCheckFa}</dd></div> : null}
        {g.status === "paused" ? <div><dd className="inline">متوقف است؛ تا «ادامه» بررسی نمی‌شود.</dd></div> : null}
        <div><dt className="inline">آخرین بررسی موفق: </dt><dd className="inline">{g.lastSuccess ? `${g.lastSuccess.atFa}، ${g.lastSuccess.statusFa}${g.lastSuccess.totalFa ? ` (${g.lastSuccess.totalFa})` : ""}` : "هنوز بررسی نشده"}</dd></div>
        {g.lastFailure ? <div className="text-anar"><dt className="inline">آخرین تلاش ناموفق: </dt><dd className="inline">{g.lastFailure.atFa}، {g.lastFailure.reason}</dd></div> : null}
      </dl>
      {g.lastAlert ? (
        <div className="mt-2 rounded-md bg-mist px-3 py-2 text-sm">
          <button type="button" className="w-full text-start" aria-expanded={showAlert}
            onClick={() => { setShowAlert(!showAlert); if (g.lastAlert?.unread) actions.onReadAlert(); }}>
            {g.lastAlert.unread ? <span className="me-1 inline-block size-2 rounded-full bg-saffron" aria-label="اعلان خوانده‌نشده" /> : null}
            اعلان {g.lastAlert.atFa}{g.lastAlert.totalFa ? `: گزینه با ${g.lastAlert.totalFa}` : ""}{g.lastAlert.telegramFa ? ` · ${g.lastAlert.telegramFa}` : ""}
          </button>
          {showAlert ? <p className="mt-2 whitespace-pre-line leading-7">{g.lastAlert.textFa}</p> : null}
        </div>
      ) : null}
      {g.changePendingFa ? <p className="mt-1 text-sm text-amber-800">{g.changePendingFa}</p> : null}
      <details className="mt-1 text-sm"><summary className="cursor-pointer text-lapis">شرط‌هایی که بررسی می‌شود</summary>
        <p className="mt-1 whitespace-pre-line leading-7 text-ink-soft">{g.summaryFa}</p></details>
      {mode === "edit" && g.editable ? <ProposeForm g={g} actions={actions} onDone={() => setMode("idle")} /> : null}
      {mode === "confirmCancel" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="تأیید لغو">
          <span>پیگیری #{g.idFa} کامل لغو شود؟</span>
          <button type="button" disabled={actions.busy} onClick={() => void actions.onAction(g.id, "cancel").then(() => setMode("idle"))}
            className="min-h-10 rounded-md bg-anar px-3 text-white disabled:opacity-60">بله، لغو کن</button>
          <button type="button" onClick={() => setMode("idle")} className="min-h-10 rounded-md px-3 text-ink-soft hover:bg-mist">نه</button>
        </div>
      ) : null}
      {mode === "idle" && live ? (
        <div className="mt-2 flex flex-wrap gap-1 text-sm">
          {g.status === "active" ? <Btn disabled={actions.busy} onClick={() => void actions.onAction(g.id, "pause")}>توقف</Btn> : null}
          {g.status === "paused" ? <Btn disabled={actions.busy} onClick={() => void actions.onAction(g.id, "resume")}>ادامه</Btn> : null}
          {g.editable ? <Btn disabled={actions.busy} onClick={() => setMode("edit")}>تغییر شرایط</Btn> : null}
          <Btn disabled={actions.busy} danger onClick={() => setMode("confirmCancel")}>لغو پیگیری</Btn>
        </div>
      ) : null}
    </article>
  );
}

const Btn = ({ children, onClick, disabled, danger }: { children: string; onClick: () => void; disabled?: boolean; danger?: boolean }) => (
  <button type="button" disabled={disabled} onClick={onClick}
    className={`min-h-10 rounded-md px-3 hover:bg-mist disabled:opacity-50 ${danger ? "text-anar" : "text-lapis"}`}>{children}</button>
);

function ProposeForm({ g, actions, onDone }: { g: GoalView; actions: GoalActions; onDone: () => void }) {
  const [budget, setBudget] = useState(g.editable?.budgetToman ? `${(g.editable.budgetToman / 1_000_000).toLocaleString("fa-IR")} میلیون` : "");
  const [stars, setStars] = useState(g.editable?.minimumHotelStars ?? 0);
  const [error, setError] = useState<string | null>(null);
  const id = `propose-${g.id}`;
  return (
    <form className="mt-2 space-y-2 rounded-md border border-line p-3 text-sm" aria-label={`تغییر شرایط هدف ${g.idFa}`}
      onSubmit={async (e) => { e.preventDefault(); setError(null); const err = await actions.onPropose(g.id, { budget, stars }); if (err) setError(err); else onDone(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onDone(); }}>
      <p className="text-ink-soft">تغییر فقط پیشنهاد می‌شود؛ تا تأییدش نکنی، پیگیری با شرایط فعلی ادامه دارد.</p>
      <label htmlFor={`${id}-b`} className="block">سقف بودجه</label>
      <input id={`${id}-b`} value={budget} onChange={(e) => setBudget(e.target.value)} className="min-h-10 w-full rounded-md border border-line bg-mist px-3" />
      <label htmlFor={`${id}-s`} className="block">حداقل ستارهٔ هتل</label>
      <select id={`${id}-s`} value={stars} onChange={(e) => setStars(Number(e.target.value))} className="min-h-10 w-full rounded-md border border-line bg-mist px-2">
        {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 0 ? "مهم نیست" : `${n.toLocaleString("fa-IR")} ستاره`}</option>)}
      </select>
      {error ? <p role="alert" className="text-anar">{error}</p> : null}
      <div className="flex gap-2">
        <button type="submit" disabled={actions.busy} className="min-h-10 rounded-md bg-firouzeh px-4 text-white disabled:opacity-60">پیشنهاد تغییر</button>
        <button type="button" onClick={onDone} className="min-h-10 rounded-md px-3 text-ink-soft hover:bg-mist">انصراف</button>
      </div>
    </form>
  );
}

export function Activities({ goals, actions }: { goals: GoalView[]; actions: GoalActions }) {
  if (!goals.length) return <p className="text-sm leading-7 text-ink-soft">پیوا فعلاً چیزی را زیر نظر ندارد. در گفتگو بگو «اگه قیمت پایین اومد خبرم کن».</p>;
  return <div className="space-y-4">{goals.map((g) => <GoalCard key={g.id} g={g} actions={actions} />)}</div>;
}
