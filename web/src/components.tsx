import type { ComparisonCards, FlightCard, GoalView, OptionCard, PendingView } from "./types.ts";

export function Wordmark({ info }: { info: { llm: string } | null }) {
  return (
    <div className="flex items-baseline gap-3">
      <h1 className="font-display text-4xl leading-none text-firouzeh-deep">پیوا</h1>
      <p className="text-sm text-ink-soft">دستیار شخصی شما برای سفر{info ? <span className="sr-only"> (مدل {info.llm})</span> : null}</p>
    </div>
  );
}

function Leg({ label, f }: { label: string; f: FlightCard }) {
  return (
    <div className="grid grid-cols-[3.5rem_1fr_auto] items-baseline gap-x-3 py-1.5">
      <span className="text-sm text-ink-soft">{label}</span>
      <span>
        <span className="font-medium">{f.airline}</span> <span className="ltr font-medium text-lapis">{f.flightNumbers}</span>
        <span className="ms-2 text-sm text-ink-soft">{f.departFa} ← {f.arriveFa} · {f.seatsFa}</span>
      </span>
      <span className="text-sm tabular-nums text-ink-soft">{f.priceFa}</span>
    </div>
  );
}

function Ticket({ o }: { o: OptionCard }) {
  const budget = o.withinBudget === true ? { t: "در بودجه", c: "text-firouzeh-deep" } : o.withinBudget === false ? { t: "بالاتر از بودجه", c: "text-anar" } : null;
  return (
    <li className="ticket grid rounded-lg border border-line bg-paper sm:grid-cols-[1fr_12rem]" data-testid="ticket">
      <div className="px-4 py-3">
        {o.outbound ? <Leg label="رفت" f={o.outbound} /> : null}
        {o.return ? <Leg label="برگشت" f={o.return} /> : null}
        {o.hotel ? (
          <div className="grid grid-cols-[3.5rem_1fr_auto] items-baseline gap-x-3 py-1.5">
            <span className="text-sm text-ink-soft">هتل</span>
            <span><span className="font-medium">{o.hotel.name}</span>{o.hotel.starsFa ? <span className="ms-2 text-sm text-ink-soft">{o.hotel.starsFa}</span> : null}
              <span className="ms-2 text-sm text-ink-soft">{o.hotel.nightsFa} · {o.hotel.roomsFa}</span></span>
            <span className="text-sm tabular-nums text-ink-soft">{o.hotel.priceFa}</span>
          </div>
        ) : null}
        {o.warningsFa.map((w) => <p key={w} className="mt-1 text-sm text-ink-soft">⚠ {w}</p>)}
      </div>
      <div className="ticket-stub flex flex-col justify-center gap-1 px-4 py-3">
        <span className="text-sm text-ink-soft">گزینهٔ {o.rankFa} · جمع</span>
        <span className="text-xl font-bold tabular-nums">{o.totalFa}</span>
        {budget ? <span className={`text-sm font-medium ${budget.c}`}>{budget.t}</span> : null}
      </div>
    </li>
  );
}

export function ResultTickets({ cards }: { cards: ComparisonCards }) {
  return (
    <section aria-label="مقایسهٔ گزینه‌ها" className="mt-4 space-y-5">
      {cards.planNoteFa ? <p className="text-sm text-ink-soft">{cards.planNoteFa}</p> : null}
      {cards.candidates.map((c) => (
        <div key={c.titleFa}>
          <h3 className="mb-2 font-medium">{c.titleFa} <span className="text-sm font-normal text-ink-soft">({c.nightsFa})</span></h3>
          {c.staleFa ? <p className="mb-2 text-sm text-saffron">⚠ {c.staleFa}</p> : null}
          {c.options.length ? <ol className="space-y-3">{c.options.map((o) => <Ticket key={o.rankFa} o={o} />)}</ol>
            : <p className="rounded-lg border border-dashed border-line px-4 py-3 text-ink-soft">نتیجهٔ کامل نشد: {c.reasonsFa.join("؛ ")}</p>}
          {c.notesFa.map((n) => <p key={n} className="mt-2 text-sm text-ink-soft">{n}</p>)}
          {c.sourceFa ? <p className="mt-2 text-xs text-ink-soft">{c.sourceFa}</p> : null}
        </div>
      ))}
      {cards.disclosuresFa.length ? <p className="text-sm text-ink-soft">{cards.disclosuresFa.join("؛ ")}</p> : null}
      <p className="text-xs text-ink-soft">{cards.disclaimerFa}</p>
    </section>
  );
}

export function ApprovalPanel({ pending, busy, onDecide }: { pending: NonNullable<PendingView>; busy: boolean; onDecide: (approve: boolean) => void }) {
  const goal = pending.kind === "goal";
  return (
    <section role="dialog" aria-labelledby="approval-title" className="stamp-in rounded-lg border-2 border-firouzeh bg-paper px-5 py-4">
      <h2 id="approval-title" className="font-bold">{goal ? "پیگیری قیمت با این شرط‌ها فعال شود؟" : "این ترجیح برای سفرهای بعدی ذخیره شود؟"}</h2>
      <p className="mt-2 whitespace-pre-line leading-8">{goal ? pending.summaryFa : pending.textFa}</p>
      {goal ? <p className="mt-2 text-sm text-ink-soft">بررسی‌ها با فاصلهٔ دست‌کم ۶ ساعت انجام می‌شوند و فقط وقتی worker روشن است. رزرو یا پرداختی انجام نمی‌شود.</p> : null}
      <div className="mt-4 flex gap-3">
        <button type="button" disabled={busy} onClick={() => onDecide(true)}
          className="rounded-md bg-firouzeh px-5 py-2 font-medium text-white hover:bg-firouzeh-deep disabled:opacity-50">{goal ? "فعال کن" : "ذخیره کن"}</button>
        <button type="button" disabled={busy} onClick={() => onDecide(false)}
          className="rounded-md px-4 py-2 text-ink-soft hover:bg-mist disabled:opacity-50">{goal ? "فعال نکن" : "ذخیره نکن"}</button>
      </div>
    </section>
  );
}

const STATUS_TONE: Record<string, string> = { active: "bg-firouzeh-wash text-firouzeh-deep", paused: "bg-amber-50 text-amber-800", draft: "bg-mist text-ink-soft" };

export function GoalsPanel({ goals, busy, onAction }: { goals: GoalView[]; busy: boolean; onAction: (id: number, a: "pause" | "resume" | "cancel") => void }) {
  if (!goals.length) return <p className="text-sm leading-7 text-ink-soft">هنوز هدفی برای پیگیری نداری. در گفتگو بگو «اگه پیدا شد خبرم کن».</p>;
  return (
    <ul className="space-y-4">
      {goals.map((g) => (
        <li key={g.id} className="border-b border-line pb-4 last:border-0" data-testid="goal">
          <div className="flex items-start justify-between gap-2">
            <span className="font-medium leading-7">{g.name}</span>
            <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${STATUS_TONE[g.status] ?? "bg-mist"}`}>{g.statusFa}</span>
          </div>
          <dl className="mt-1 space-y-0.5 text-sm text-ink-soft">
            {g.nextCheckFa ? <div><dt className="inline">بررسی بعدی: </dt><dd className="inline">{g.nextCheckFa}</dd></div> : null}
            <div><dt className="inline">آخرین بررسی موفق: </dt><dd className="inline">{g.lastSuccess ? `${g.lastSuccess.atFa}، ${g.lastSuccess.statusFa}${g.lastSuccess.totalFa ? ` (${g.lastSuccess.totalFa})` : ""}` : "هنوز نه"}</dd></div>
            {g.lastFailure ? <div><dt className="inline">آخرین خطا: </dt><dd className="inline">{g.lastFailure.atFa}، {g.lastFailure.reason}</dd></div> : null}
          </dl>
          {g.summaryFa ? <details className="mt-1 text-sm"><summary className="cursor-pointer text-lapis">شرط‌ها</summary><p className="mt-1 whitespace-pre-line leading-7 text-ink-soft">{g.summaryFa}</p></details> : null}
          <div className="mt-2 flex gap-2 text-sm">
            {g.status === "active" ? <button type="button" disabled={busy} className="text-lapis hover:underline" onClick={() => onAction(g.id, "pause")}>توقف</button> : null}
            {g.status === "paused" ? <button type="button" disabled={busy} className="text-lapis hover:underline" onClick={() => onAction(g.id, "resume")}>ادامه</button> : null}
            {g.status !== "draft" ? <button type="button" disabled={busy} className="text-anar hover:underline" onClick={() => onAction(g.id, "cancel")}>لغو پیگیری</button> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
