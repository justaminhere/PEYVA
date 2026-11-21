/**
 * "What PEYVA understood": the current trip goal as compact chips above the composer.
 * Every chip is a real, editable field of the server's goal; edits are validated by the server (POST /api/trip).
 */
import { useEffect, useRef, useState } from "react";
import type { TripField, TripFieldKey, TripView } from "../types.ts";

export interface BriefProps {
  trip: TripView;
  busy: boolean;
  checking: boolean;
  onEdit: (field: TripFieldKey | "confirmAssumptions", value: string | number | true) => Promise<string | null>;
  onCompare: () => void;
}

const OPTIONAL: TripFieldKey[] = ["budget", "stars"];

export function Brief({ trip, busy, checking, onEdit, onCompare }: BriefProps) {
  const [editing, setEditing] = useState<TripFieldKey | null>(null);
  const [returnFocus, setReturnFocus] = useState<TripFieldKey | null>(null);
  const chipRefs = useRef(new Map<TripFieldKey, HTMLButtonElement | null>());
  // Focus goes back to the chip once it is enabled again (it is disabled while the save request runs).
  useEffect(() => {
    if (returnFocus && !editing && !busy) { chipRefs.current.get(returnFocus)?.focus(); setReturnFocus(null); }
  }, [returnFocus, editing, busy]);
  if (trip.empty) return null;
  const shown = trip.fields.filter((f) => f.valueFa !== null || f.missing || OPTIONAL.includes(f.key));
  const close = (key: TripFieldKey) => { setEditing(null); setReturnFocus(key); };
  const field = editing && trip.fields.find((f) => f.key === editing);
  return (
    <section aria-label="آنچه پیوا از سفرت فهمیده" className="mb-2 rounded-xl border border-line bg-paper px-3 py-2">
      {field ? <FieldEditor field={field} busy={busy} onCancel={() => close(field.key)}
        onSave={async (v) => { const err = await onEdit(field.key, v); if (!err) close(field.key); return err; }} /> : (
        // Mobile: one swipeable row, so the brief never eats the conversation; wider screens wrap.
        <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible">
          <span className="me-1 shrink-0 text-xs text-ink-soft">آنچه فهمیدم:</span>
          {shown.map((f) => (
            <button key={f.key} ref={(el) => { chipRefs.current.set(f.key, el); }} type="button" disabled={busy} onClick={() => setEditing(f.key)}
              aria-label={`${f.labelFa}: ${f.valueFa ?? "مشخص نشده"}؛ ویرایش`}
              className={`min-h-9 shrink-0 whitespace-nowrap rounded-full px-3 text-sm transition-colors disabled:opacity-60 ${f.valueFa ? "bg-mist hover:bg-firouzeh-wash" : f.missing
                ? "border border-dashed border-saffron text-ink hover:bg-amber-50" : "border border-dashed border-line text-ink-soft hover:border-firouzeh"}`}>
              {f.valueFa ? <><span className="text-ink-soft">{f.labelFa} </span>{f.valueFa}</> : <>+ {f.labelFa}{f.missing ? "؟" : ""}</>}
            </button>
          ))}
          {trip.monitoredBy ? <span className="min-h-9 shrink-0 whitespace-nowrap rounded-full bg-firouzeh-wash px-3 py-1.5 text-sm text-firouzeh-deep">زیر نظر پیوا · #{trip.monitoredBy.goalIdFa}</span> : null}
        </div>
      )}
      {!field && trip.assumptionsFa.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span>{trip.assumptionsFa.join("؛ ")}</span>
          <button type="button" disabled={busy} onClick={() => void onEdit("confirmAssumptions", true)}
            className="min-h-9 rounded-md bg-lapis px-3 text-white disabled:opacity-60">درست است</button>
        </div>
      ) : null}
      {!field && trip.conflictsFa.length ? <p role="alert" className="mt-2 text-sm text-anar">{trip.conflictsFa.join("؛ ")}</p> : null}
      {!field && trip.ready && trip.results !== "current" ? (
        <div className="mt-2 flex items-center gap-2">
          <button type="button" disabled={busy || checking} onClick={onCompare}
            className="min-h-10 whitespace-nowrap rounded-lg bg-firouzeh px-4 text-sm font-medium text-white hover:bg-firouzeh-deep disabled:opacity-60">
            {checking ? "در حال جست‌وجو در MrBilit…" : trip.results === "outdated" ? "جست‌وجوی دوباره با شرایط تازه" : "جست‌وجو با همین شرایط"}
          </button>
          {trip.results === "outdated" ? <span className="hidden text-xs text-ink-soft sm:inline">نتایج قبلی با شرایط قبلی بود.</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function FieldEditor({ field, busy, onSave, onCancel }: { field: TripField; busy: boolean; onSave: (v: string | number) => Promise<string | null>; onCancel: () => void }) {
  const [value, setValue] = useState(field.input.value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const submit = async () => {
    if (field.input.type !== "stars" && !String(value).trim()) { setError("مقداری بنویس."); return; }
    setSaving(true); setError(null);
    const err = await onSave(field.input.type === "text" ? String(value) : Number(value));
    setSaving(false);
    if (err) { setError(err); input.current?.focus(); }
  };
  const id = `edit-${field.key}`;
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}>
      <label htmlFor={id} className="text-sm font-medium">{field.labelFa}</label>
      {field.input.type === "stars" ? (
        <div role="radiogroup" aria-label="حداقل ستارهٔ هتل" className="flex gap-1">
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={String(value) === String(n)} onClick={() => setValue(String(n))}
              className={`min-h-9 min-w-9 rounded-md px-2 text-sm ${String(value) === String(n) ? "bg-firouzeh text-white" : "bg-mist"}`}>
              {n === 0 ? "مهم نیست" : `${n.toLocaleString("fa-IR")}★`}
            </button>
          ))}
          <input ref={input} id={id} type="hidden" value={value} readOnly />
        </div>
      ) : (
        <input ref={input} id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder={field.input.placeholderFa}
          inputMode={field.input.type === "number" ? "numeric" : "text"} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined}
          className="min-h-10 min-w-0 flex-1 rounded-md border border-line bg-mist px-3 outline-none focus:border-firouzeh" />
      )}
      <button type="submit" disabled={busy || saving} className="min-h-10 rounded-md bg-firouzeh px-4 text-sm font-medium text-white disabled:opacity-60">
        {saving ? "در حال ثبت…" : "ثبت"}
      </button>
      <button type="button" onClick={onCancel} className="min-h-10 rounded-md px-3 text-sm text-ink-soft hover:bg-mist">انصراف</button>
      {error ? <p id={`${id}-err`} role="alert" className="basis-full text-sm text-anar">{error}</p> : null}
    </form>
  );
}
