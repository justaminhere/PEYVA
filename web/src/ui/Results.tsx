/** Deterministic comparison results (server view model from the comparison engine). Nothing here is computed from prose. */
import { useState } from "react";
import type { CandidateCard, ComparisonCards, FlightCard, OptionCard } from "../types.ts";

function Leg({ label, f, showPrice = true }: { label: string; f: FlightCard; showPrice?: boolean }) {
  return (
    <div className="grid grid-cols-[3.25rem_1fr_auto] items-baseline gap-x-3 py-1">
      <span className="text-sm text-ink-soft">{label}</span>
      <span>
        <span className="font-medium">{f.airline}</span> <bdi className="font-medium text-lapis" dir="ltr">{f.flightNumbers}</bdi>
        <span className="ms-2 text-sm text-ink-soft">{f.departFa} ← {f.arriveFa} · {f.seatsFa}</span>
      </span>
      {showPrice ? <span className="text-sm tabular-nums text-ink-soft">{f.priceFa}</span> : <span />}
    </div>
  );
}

function Budget({ o }: { o: OptionCard }) {
  if (o.withinBudget === null) return null;
  return <span className={`text-sm font-medium ${o.withinBudget ? "text-firouzeh-deep" : "text-anar"}`}>{o.withinBudget ? "در بودجه" : "بالاتر از بودجه"}</span>;
}

function HotelRow({ o }: { o: OptionCard }) {
  return (
    <li className="ticket grid rounded-lg border border-line bg-paper sm:grid-cols-[1fr_12rem]" data-testid="ticket">
      <div className="px-4 py-2.5">
        {o.hotel ? <p><span className="font-medium">{o.hotel.name}</span>{o.hotel.starsFa ? <span className="ms-2 text-sm text-ink-soft">{o.hotel.starsFa}</span> : null}
          <span className="ms-2 text-sm text-ink-soft">{o.hotel.nightsFa} · {o.hotel.roomsFa} · هتل {o.hotel.priceFa}</span></p> : null}
        {o.matchFa.length ? <p className="mt-0.5 text-sm text-ink-soft">{o.matchFa.join(" · ")}</p> : null}
        {o.warningsFa.map((w) => <p key={w} className="text-sm text-ink-soft">⚠ {w}</p>)}
      </div>
      <div className="ticket-stub flex flex-col justify-center gap-0.5 px-4 py-2.5">
        <span className="text-xs text-ink-soft">گزینهٔ {o.rankFa} · جمع سفر</span>
        <span className="text-lg font-bold tabular-nums">{o.totalFa}</span>
        <Budget o={o} />
      </div>
    </li>
  );
}

function FullTicket({ o }: { o: OptionCard }) {
  return (
    <li className="ticket grid rounded-lg border border-line bg-paper sm:grid-cols-[1fr_12rem]" data-testid="ticket">
      <div className="px-4 py-3">
        {o.outbound ? <Leg label="رفت" f={o.outbound} /> : null}
        {o.return ? <Leg label="برگشت" f={o.return} /> : null}
        {o.hotel ? (
          <div className="grid grid-cols-[3.25rem_1fr_auto] items-baseline gap-x-3 py-1">
            <span className="text-sm text-ink-soft">هتل</span>
            <span><span className="font-medium">{o.hotel.name}</span>{o.hotel.starsFa ? <span className="ms-2 text-sm text-ink-soft">{o.hotel.starsFa}</span> : null}
              <span className="ms-2 text-sm text-ink-soft">{o.hotel.nightsFa} · {o.hotel.roomsFa}</span></span>
            <span className="text-sm tabular-nums text-ink-soft">{o.hotel.priceFa}</span>
          </div>
        ) : null}
        {o.matchFa.length ? <p className="mt-1 text-sm text-ink-soft">{o.matchFa.join(" · ")}</p> : null}
        {o.warningsFa.map((w) => <p key={w} className="mt-1 text-sm text-ink-soft">⚠ {w}</p>)}
      </div>
      <div className="ticket-stub flex flex-col justify-center gap-1 px-4 py-3">
        <span className="text-sm text-ink-soft">گزینهٔ {o.rankFa} · جمع سفر</span>
        <span className="text-xl font-bold tabular-nums">{o.totalFa}</span>
        <Budget o={o} />
      </div>
    </li>
  );
}

function Candidate({ c }: { c: CandidateCard }) {
  return (
    <div data-testid="candidate">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="font-medium">{c.titleFa} <span className="text-sm font-normal text-ink-soft">({c.nightsFa})</span></h3>
        {c.checkedFa ? <span className={`rounded px-2 py-0.5 text-xs ${c.fresh ? "bg-firouzeh-wash text-firouzeh-deep" : "bg-amber-50 text-amber-800"}`}>
          {c.fresh ? `قیمت تازه · ساعت ${c.checkedFa}` : `قدیمی · بررسی ساعت ${c.checkedFa}`}</span> : null}
      </div>
      {c.staleFa ? <p className="mb-2 text-sm text-amber-800">⚠ {c.staleFa}</p> : null}
      {!c.options.length ? <p className="rounded-lg border border-dashed border-line px-4 py-3 text-ink-soft">{c.statusFa}: {c.reasonsFa.join("؛ ")}</p>
        : c.sharedFlights ? (
          <>
            <div className="mb-2 rounded-lg border border-line bg-paper px-4 py-2">
              <p className="mb-0.5 text-xs text-ink-soft">پرواز همهٔ گزینه‌ها</p>
              {c.sharedFlights.outbound ? <Leg label="رفت" f={c.sharedFlights.outbound} /> : null}
              {c.sharedFlights.return ? <Leg label="برگشت" f={c.sharedFlights.return} /> : null}
            </div>
            <ol className="space-y-2" aria-label="گزینه‌ها بر اساس جمع هزینه">{c.options.map((o) => <HotelRow key={o.rankFa} o={o} />)}</ol>
          </>
        ) : <ol className="space-y-3">{c.options.map((o) => <FullTicket key={o.rankFa} o={o} />)}</ol>}
      {c.notesFa.map((n) => <p key={n} className="mt-2 text-sm text-ink-soft">{n}</p>)}
      {c.sourceFa ? <p className="mt-2 text-xs text-ink-soft">{c.sourceFa}</p> : null}
    </div>
  );
}

export function ResultTickets({ cards }: { cards: ComparisonCards }) {
  const many = cards.candidates.length > 1;
  const [open, setOpen] = useState<number>(cards.bestIndex ?? 0);
  return (
    <section aria-label="مقایسهٔ گزینه‌ها" className="space-y-4">
      {cards.planNoteFa ? <p className="text-sm text-ink-soft">{cards.planNoteFa}</p> : null}
      {many ? (
        <div role="tablist" aria-label="تاریخ‌های بررسی‌شده" className="grid gap-2 sm:grid-cols-3">
          {cards.candidates.map((c, i) => (
            <button key={c.titleFa} role="tab" type="button" aria-selected={open === i} onClick={() => setOpen(i)} data-testid="date-option"
              className={`rounded-lg border px-3 py-2 text-start transition-colors ${open === i ? "border-firouzeh bg-firouzeh-wash" : "border-line bg-paper hover:border-firouzeh"}`}>
              <span className="block text-sm">{c.titleFa}</span>
              <span className="block text-base font-bold tabular-nums">{c.cheapestTotalFa ?? c.statusFa}</span>
              <span className="block text-xs text-ink-soft">
                {cards.bestIndex === i ? "ارزان‌ترین گزینهٔ در بودجه · " : ""}{c.cheapestTotalFa ? (c.cheapestWithinBudget === false ? "بالاتر از بودجه" : c.cheapestWithinBudget ? "در بودجه" : "") : c.statusFa}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div role={many ? "tabpanel" : undefined}>{cards.candidates[many ? open : 0] ? <Candidate c={cards.candidates[many ? open : 0]!} /> : null}</div>
      {cards.disclosuresFa.length ? <p className="text-sm text-ink-soft">{cards.disclosuresFa.join("؛ ")}</p> : null}
      <p className="text-xs text-ink-soft">{cards.disclaimerFa}</p>
    </section>
  );
}
