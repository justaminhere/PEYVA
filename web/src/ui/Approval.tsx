/** An action that waits for the user's explicit decision. Text comes from the server; buttons call the single approval path. */
import type { PendingView } from "../types.ts";

export function ApprovalPanel({ pending, busy, onDecide }: { pending: NonNullable<PendingView>; busy: boolean; onDecide: (approve: boolean) => void }) {
  const goal = pending.kind === "goal";
  const change = goal && pending.change;
  const title = change ? `شرایط پیگیری #${pending.goalIdFa} تغییر کند؟` : goal ? "پیگیری قیمت با این شرط‌ها فعال شود؟" : "این ترجیح برای سفرهای بعدی ذخیره شود؟";
  return (
    <section role="region" aria-labelledby="approval-title" data-testid="approval" className="stamp-in rounded-xl border-2 border-firouzeh bg-paper px-5 py-4">
      <h2 id="approval-title" className="font-bold">{title}</h2>
      {change && pending.diff.length ? (
        <table className="mt-3 w-full text-sm">
          <thead><tr className="text-ink-soft"><th className="py-1 text-start font-normal">شرط</th><th className="py-1 text-start font-normal">الان</th><th className="py-1 text-start font-normal">بعد از تأیید</th></tr></thead>
          <tbody>{pending.diff.map((d) => (
            <tr key={d.labelFa} className="border-t border-line"><td className="py-1.5">{d.labelFa}</td><td className="py-1.5 text-ink-soft line-through decoration-anar/60">{d.beforeFa}</td><td className="py-1.5 font-medium">{d.afterFa}</td></tr>
          ))}</tbody>
        </table>
      ) : <p className="mt-2 whitespace-pre-line leading-8">{goal ? pending.summaryFa : pending.textFa}</p>}
      <p className="mt-2 text-sm text-ink-soft">
        {change ? "تا تأیید نکنی، پیگیری با شرایط فعلی ادامه دارد. «تغییر نده» همه‌چیز را مثل قبل نگه می‌دارد."
          : goal ? "بررسی‌ها با فاصلهٔ دست‌کم ۶ ساعت انجام می‌شوند و فقط وقتی worker پیوا روشن است. رزرو یا پرداختی انجام نمی‌شود." : "بعداً می‌توانی پاکش کنی."}
      </p>
      <div className="mt-4 flex gap-3">
        <button type="button" disabled={busy} onClick={() => onDecide(true)}
          className="min-h-11 rounded-lg bg-firouzeh px-5 font-medium text-white hover:bg-firouzeh-deep disabled:opacity-50">{change ? "تغییر بده" : goal ? "فعال کن" : "ذخیره کن"}</button>
        <button type="button" disabled={busy} onClick={() => onDecide(false)}
          className="min-h-11 rounded-lg px-4 text-ink-soft hover:bg-mist disabled:opacity-50">{change ? "تغییر نده" : goal ? "فعال نکن" : "ذخیره نکن"}</button>
      </div>
    </section>
  );
}
