/**
 * UI tests: the real React app, talking to the real PEYVA server in-process (real PostgreSQL, recorded MrBilit data,
 * TEST-ONLY scripted streaming LLM). Only the browser is replaced by happy-dom.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DbHandle } from "../../src/db/client.ts";
import { goals, goalChecks, messages, notifications, preferences } from "../../src/db/schema.ts";
import { freshDb } from "../../test/support/pg.ts";
import { webApp } from "../../test/support/web.ts";
import { ScriptedLlm, ScriptedStreamingLlm, call, say, tools } from "../../test/support/scripted-llm.ts";
import { App } from "../src/App.tsx";
import { createApi } from "../src/api.ts";
import { readSse } from "../src/sse.ts";
import type { LlmClient } from "../../src/llm/types.ts";

let h: DbHandle & { url: string };
const now = () => new Date("2026-11-20T10:00:00Z");
beforeAll(async () => { h = await freshDb(); });
afterAll(() => h.close());
beforeEach(async () => { for (const t of [notifications, goalChecks, goals, preferences, messages]) await h.db.delete(t); });
afterEach(() => cleanup());

const TEXT = "سفر ۳ شبه تهران به کیش ۱۹ آذر ۱۴۰۵، یک نفر، یک اتاق، زیر ۳۰ میلیون؛ اگه پیدا شد خبرم کن";
const goalCall = tools(call("update_trip_goal", { intent: "trip", origin: "تهران", destination: "کیش", departureDate: { text: "۱۹ آذر ۱۴۰۵" },
  nights: 3, adults: 1, rooms: 1, budgetText: "۳۰ میلیون", monitoringRequested: true }));

/**
 * Polls with real time. Testing Library's waitFor detects the `jest` global that bun:test defines and tries to drive
 * fake timers, and a failing expect() inside a retry loop is recorded by bun:test; so conditions here throw plain errors.
 */
async function eventually<T>(f: () => T, timeoutMs = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    try { return f(); } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw e;
      await act(async () => { await Bun.sleep(25); });
    }
  }
}

const ensure = (cond: unknown, what: string) => { if (!cond) throw new Error(`not yet: ${what}`); };

async function mount(llm: LlmClient) {
  const w = await webApp(h, llm, now);
  const api = createApi((path, init) => w.call(path, init));
  render(<App api={api} />);
  await eventually(() => screen.getByText(/بگو کجا می‌خواهی بروی/));
  return w;
}
/** Types a message, sends it and waits until the streamed turn has finished. */
async function type(text: string) {
  const box = screen.getByLabelText("پیام به پیوا");
  await act(async () => { fireEvent.change(box, { target: { value: text } }); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "بفرست" })); });
  await eventually(() => ensure(!document.querySelector('[aria-busy="true"]'), "turn finished"));
}

test("a conversation renders progress, the LLM's words, ticket cards from real results and an approval panel", async () => {
  await mount(new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("گزینهٔ ۱ با ۲۵٬۱۱۴٬۳۰۰ تومان در بودجه است.")]));
  await type(TEXT);
  const p = screen.getByText("گزینهٔ ۱ با ۲۵٬۱۱۴٬۳۰۰ تومان در بودجه است.");
  expect(p.className).not.toContain("caret"); // final text, not the live stream
  expect(screen.getByText(TEXT)).toBeTruthy(); // the user's message
  const steps = screen.getByLabelText("کارهای انجام‌شده"); // collapsed summary once the turn is done
  expect(within(steps).getByText(/^✓ ثبت جزئیات سفر، آماده‌کردن شرایط پیگیری · ۳ جست‌وجوی واقعی$/)).toBeTruthy();
  expect(within(steps).getAllByText(/🔎 پرواز/)).toHaveLength(2);
  const tickets = screen.getAllByTestId("ticket");
  expect(tickets.length).toBeGreaterThan(0);
  expect(within(tickets[0]!).getByText("۲۵٬۱۱۴٬۳۰۰ تومان")).toBeTruthy();
  expect(within(screen.getByTestId("candidate")).getByText("ZV 4030")).toBeTruthy(); // the shared flight is shown once, above the hotel options
  expect(within(tickets[0]!).getByText("در بودجه")).toBeTruthy();
  const dialog = screen.getByTestId("approval");
  expect(within(dialog).getByRole("heading").textContent).toBe("پیگیری قیمت با این شرط‌ها فعال شود؟");
  expect(within(dialog).getByText(/۳۰٬۰۰۰٬۰۰۰ تومان/)).toBeTruthy();
  expect(screen.queryByText(/با همین مشخصات پیگیری را فعال کنم/)).toBeNull(); // not duplicated in the text
  expect(screen.getAllByTestId("goal")[0]!.textContent).toContain("پیش‌نویس");
});

test("clicking 'فعال کن' activates the goal in PostgreSQL; the confirmation and goal status come from the database", async () => {
  const w = await mount(new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید می‌کنی؟")]));
  await type(TEXT);
  const dialog = await eventually(() => screen.getByTestId("approval"));
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "فعال کن" })); });
  await eventually(() => within(screen.getByRole("main")).getByText(/پیگیری فعال شد ✅/));
  expect(screen.queryByTestId("approval")).toBeNull();
  const [row] = await w.ctx.goals.list("amin");
  expect(row).toMatchObject({ status: "active" });
  await eventually(() => ensure(screen.getAllByTestId("goal")[0]!.textContent?.includes("فعال"), "goal active"));
  expect(screen.getAllByTestId("goal")[0]!.textContent).toContain("بررسی بعدی:");
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "توقف" })[0]!); });
  await eventually(() => ensure(screen.getAllByTestId("goal")[0]!.textContent?.includes("متوقف"), "goal paused"));
  expect((await w.ctx.goals.get("amin", row!.id))!.status).toBe("paused");
});

test("a budget change shows a change panel; 'تغییر نده' leaves the active goal as it was", async () => {
  const w = await mount(new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید می‌کنی؟")]));
  await type(TEXT);
  await act(async () => { fireEvent.click(within(await eventually(() => screen.getByTestId("approval"))).getByRole("button", { name: "فعال کن" })); });
  await eventually(() => within(screen.getByRole("main")).getByText(/پیگیری فعال شد ✅/));
  const [g] = await w.ctx.goals.list("amin");
  await type(`/budget ${g!.id} ۲۸ میلیون`);
  const dialog = await eventually(() => screen.getByTestId("approval"));
  expect(within(dialog).getByRole("heading").textContent).toContain("تغییر کند؟");
  expect(within(dialog).getByText("۲۸٬۰۰۰٬۰۰۰ تومان")).toBeTruthy(); // after
  expect(within(dialog).getByText("۳۰٬۰۰۰٬۰۰۰ تومان")).toBeTruthy(); // before: only the changed line is listed
  expect(screen.getAllByTestId("goal")[0]!.textContent).toContain("منتظر تأیید");
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "تغییر نده" })); });
  await eventually(() => within(screen.getByRole("main")).getByText(/با شرایط قبلی ادامه دارد/));
  expect(await w.ctx.goals.get("amin", g!.id)).toMatchObject({ status: "active", constraintsHash: g!.constraintsHash, proposedHash: null });
});

test("'فعال نکن' cancels the draft and nothing is monitored", async () => {
  const w = await mount(new ScriptedLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید؟")]));
  await type(TEXT);
  const dialog = await eventually(() => screen.getByTestId("approval"));
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "فعال نکن" })); });
  await eventually(() => within(screen.getByRole("main")).getByText(/پیگیری فعال نشد/));
  expect(await w.ctx.goals.list("amin")).toEqual([]); // canceled goals are not listed
});

test("an LLM error is shown as an error, with no invented answer", async () => {
  await mount(new ScriptedLlm([{ ok: false, cause: "network", message: "connect ECONNREFUSED" }]));
  await type("سلام");
  await eventually(() => screen.getByText(/اتصال به سرویس مدل زبانی برقرار نشد/));
  expect(screen.queryAllByTestId("ticket")).toHaveLength(0);
});

test("reload restores the transcript and the last comparison from the server", async () => {
  const w = await mount(new ScriptedStreamingLlm([goalCall, say("گزینه‌ها آماده است.")]));
  await type("تهران به کیش ۱۹ آذر ۱۴۰۵ سه شب یک نفر یک اتاق بودجه ۳۰ میلیون");
  await eventually(() => screen.getByText("گزینه‌ها آماده است."));
  cleanup();
  render(<App api={createApi((p, i) => w.call(p, i))} />);
  await eventually(() => screen.getByText("گزینه‌ها آماده است."));
  expect(screen.getAllByTestId("ticket").length).toBeGreaterThan(0);
});

test("SSE reader: events split across network chunks, comments ignored", async () => {
  const enc = new TextEncoder();
  const parts = ["event: delta\ndata: {\"te", "xt\":\"سل\"}\n\n: ping\n\n", "event: done\r\ndata: {}\r\n\r\n"];
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
  const got: string[] = [];
  for await (const m of readSse(body)) got.push(`${m.event}:${m.data}`);
  expect(got).toEqual(['delta:{"text":"سل"}', "done:{}"]);
});

// ---------- Phase 4B interactions ----------

const brief = () => screen.getByRole("region", { name: "آنچه پیوا از سفرت فهمیده" });

test("goal brief: shows what PEYVA understood, a missing detail is filled inline; invalid input is explained and nothing changes", async () => {
  const w = await mount(new ScriptedLlm([tools(call("update_trip_goal", { destination: "کیش", nights: 3 })), say("از کجا؟")]));
  await type("یه سفر سه شبه به کیش");
  expect(within(brief()).getByRole("button", { name: "مقصد: کیش؛ ویرایش" })).toBeTruthy();
  const origin = within(brief()).getByRole("button", { name: "مبدأ: مشخص نشده؛ ویرایش" });
  expect(origin.textContent).toBe("+ مبدأ؟");
  await act(async () => { fireEvent.click(origin); });
  const input = within(brief()).getByLabelText("مبدأ") as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  await act(async () => { fireEvent.change(input, { target: { value: "آتلانتیس" } }); });
  await act(async () => { fireEvent.click(within(brief()).getByRole("button", { name: "ثبت" })); });
  await eventually(() => within(brief()).getByRole("alert"));
  expect(within(brief()).getByRole("alert").textContent).toContain("نمی‌شناسم");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  await act(async () => { fireEvent.change(input, { target: { value: "تهران" } }); });
  await act(async () => { fireEvent.submit(input.closest("form")!); });
  await eventually(() => within(brief()).getByRole("button", { name: "مبدأ: تهران؛ ویرایش" }));
  expect(within(screen.getByRole("main")).getByText("تغییر دادی: مبدأ: — ← تهران")).toBeTruthy();
  expect(w.provider.calls).toEqual([]); // editing never searches by itself
  // Escape closes the editor and returns focus to the chip
  await act(async () => { fireEvent.click(within(brief()).getByRole("button", { name: "مبدأ: تهران؛ ویرایش" })); });
  await act(async () => { fireEvent.keyDown(within(brief()).getByLabelText("مبدأ"), { key: "Escape" }); });
  await act(async () => { await Bun.sleep(30); });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("مبدأ: تهران؛ ویرایش");
});

test("after an edit the shown results are marked outdated; one click re-checks with real (recorded) data, no LLM", async () => {
  const llm = new ScriptedStreamingLlm([goalCall, say("گزینه‌ها آماده است.")]);
  const w = await mount(llm);
  await type("سفر ۳ شبه تهران به کیش ۱۹ آذر ۱۴۰۵، یک نفر، یک اتاق، زیر ۳۰ میلیون");
  expect(within(brief()).queryByRole("button", { name: /جست‌وجو/ })).toBeNull(); // results are current
  await act(async () => { fireEvent.click(within(brief()).getByRole("button", { name: /^هتل: / })); });
  await act(async () => { fireEvent.click(within(brief()).getByRole("radio", { name: "۴★" })); });
  await act(async () => { fireEvent.click(within(brief()).getByRole("button", { name: "ثبت" })); });
  const again = await eventually(() => within(brief()).getByRole("button", { name: "جست‌وجوی دوباره با شرایط تازه" }));
  const calls = llm.requests.length;
  await act(async () => { fireEvent.click(again); });
  await eventually(() => within(screen.getByRole("main")).getByText("نتایج با شرایط فعلی دوباره بررسی شد."));
  const candidates = screen.getAllByTestId("candidate");
  expect(within(candidates.at(-1)!).getAllByText("۲۸٬۶۸۱٬۳۰۰ تومان").length).toBeGreaterThan(0);
  expect(llm.requests.length).toBe(calls);
  expect(w.provider.calls.length).toBe(3); // fresh cached flights/hotels reused within 15 minutes: no extra provider calls
});

test("changing an active goal from its card: proposal with a before/after table; 'تغییر نده' keeps everything", async () => {
  const w = await mount(new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید می‌کنی؟")]));
  await type(TEXT);
  await act(async () => { fireEvent.click(within(screen.getByTestId("approval")).getByRole("button", { name: "فعال کن" })); });
  await eventually(() => within(screen.getByRole("main")).getByText(/پیگیری فعال شد ✅/));
  const card = within(screen.getByRole("main")).getByTestId("goal"); // the live goal card next to the confirmation
  const [g] = await w.ctx.goals.list("amin");
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "تغییر شرایط" })); });
  const form = within(card).getByRole("form", { name: /تغییر شرایط هدف/ });
  await act(async () => { fireEvent.change(within(form).getByLabelText("سقف بودجه"), { target: { value: "۲۵ میلیون" } }); });
  await act(async () => { fireEvent.click(within(form).getByRole("button", { name: "پیشنهاد تغییر" })); });
  const panel = await eventually(() => screen.getByTestId("approval"));
  const rows = within(panel).getAllByRole("row").slice(1).map((r) => r.textContent);
  expect(rows).toEqual(["سقف جمع پرواز رفت و برگشت + هتل۳۰٬۰۰۰٬۰۰۰ تومان۲۵٬۰۰۰٬۰۰۰ تومان"]);
  await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "تغییر نده" })); });
  await eventually(() => within(screen.getByRole("main")).getByText(/با شرایط قبلی ادامه دارد/));
  expect(await w.ctx.goals.get("amin", g!.id)).toMatchObject({ status: "active", constraintsHash: g!.constraintsHash, proposedHash: null, nextCheckAt: g!.nextCheckAt });
});

test("cancelling a goal needs a second, explicit confirmation in place (no browser dialog)", async () => {
  const w = await mount(new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید؟")]));
  await type(TEXT);
  await act(async () => { fireEvent.click(within(screen.getByTestId("approval")).getByRole("button", { name: "فعال کن" })); });
  const card = await eventually(() => within(screen.getByRole("main")).getByTestId("goal"));
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "لغو پیگیری" })); });
  const [g] = await w.ctx.goals.list("amin");
  expect(g!.status).toBe("active"); // nothing happened yet
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "نه" })); });
  expect((await w.ctx.goals.get("amin", g!.id))!.status).toBe("active");
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "لغو پیگیری" })); });
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "بله، لغو کن" })); });
  await eventually(() => ensure(true, ""));
  await act(async () => { await Bun.sleep(50); });
  expect((await w.ctx.goals.get("amin", g!.id))!.status).toBe("canceled");
});

test("several candidate dates: an overview to switch between dates; the best date is selected first", async () => {
  await mount(new ScriptedStreamingLlm([tools(call("update_trip_goal", { intent: "trip", origin: "تهران", destination: "کیش", adults: 1, nights: 3, datesFlexible: true,
    dateWindow: { from: { text: "۱۰ دی ۱۴۰۵" }, to: { text: "۲۰ دی ۱۴۰۵" } }, budgetText: "۳۰ میلیون" })), say("ارزان‌ترین را علامت زدم.")]));
  await type("تهران به کیش، سه شب، یک نفر، بین ۱۰ تا ۲۰ دی ۱۴۰۵، هر تاریخی، تا ۳۰ میلیون");
  const tabs = screen.getAllByRole("tab");
  expect(tabs).toHaveLength(3);
  const selected = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
  expect(tabs[selected]!.textContent).toContain("ارزان‌ترین گزینهٔ در بودجه");
  const other = tabs.findIndex((_, i) => i !== selected);
  await act(async () => { fireEvent.click(tabs[other]!); });
  expect(tabs[other]!.getAttribute("aria-selected")).toBe("true");
  expect(within(screen.getByRole("tabpanel")).getByRole("heading").textContent).toContain(tabs[other]!.textContent!.slice(0, 10));
});
