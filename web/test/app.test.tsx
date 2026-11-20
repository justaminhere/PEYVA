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
  const steps = screen.getByLabelText("کارهای انجام‌شده");
  expect(within(steps).getByText(/ثبت جزئیات سفر/)).toBeTruthy();
  expect(within(steps).getAllByText(/🔎 پرواز/)).toHaveLength(2);
  const tickets = screen.getAllByTestId("ticket");
  expect(tickets.length).toBeGreaterThan(0);
  expect(within(tickets[0]!).getByText("۲۵٬۱۱۴٬۳۰۰ تومان")).toBeTruthy();
  expect(within(tickets[0]!).getByText("ZV 4030")).toBeTruthy();
  expect(within(tickets[0]!).getByText("در بودجه")).toBeTruthy();
  const dialog = screen.getByRole("dialog", { name: "پیگیری قیمت با این شرط‌ها فعال شود؟" });
  expect(within(dialog).getByText(/۳۰٬۰۰۰٬۰۰۰ تومان/)).toBeTruthy();
  expect(screen.queryByText(/با همین مشخصات پیگیری را فعال کنم/)).toBeNull(); // not duplicated in the text
  expect(screen.getAllByTestId("goal")[0]!.textContent).toContain("پیش‌نویس");
});

test("clicking 'فعال کن' activates the goal in PostgreSQL; the confirmation and goal status come from the database", async () => {
  const w = await mount(new ScriptedStreamingLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید می‌کنی؟")]));
  await type(TEXT);
  const dialog = await eventually(() => screen.getByRole("dialog"));
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "فعال کن" })); });
  await eventually(() => screen.getByText(/پیگیری فعال شد ✅/));
  expect(screen.queryByRole("dialog")).toBeNull();
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
  await act(async () => { fireEvent.click(within(await eventually(() => screen.getByRole("dialog"))).getByRole("button", { name: "فعال کن" })); });
  await eventually(() => screen.getByText(/پیگیری فعال شد ✅/));
  const [g] = await w.ctx.goals.list("amin");
  await type(`/budget ${g!.id} ۲۸ میلیون`);
  const dialog = await eventually(() => screen.getByRole("dialog", { name: /تغییر کند؟/ }));
  expect(within(dialog).getByText(/۲۸٬۰۰۰٬۰۰۰/)).toBeTruthy();
  expect(screen.getAllByTestId("goal")[0]!.textContent).toContain("منتظر تأیید");
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "تغییر نده" })); });
  await eventually(() => screen.getByText(/با شرایط قبلی ادامه دارد/));
  expect(await w.ctx.goals.get("amin", g!.id)).toMatchObject({ status: "active", constraintsHash: g!.constraintsHash, proposedHash: null });
});

test("'فعال نکن' cancels the draft and nothing is monitored", async () => {
  const w = await mount(new ScriptedLlm([goalCall, tools(call("start_monitoring", {})), say("تأیید؟")]));
  await type(TEXT);
  const dialog = await eventually(() => screen.getByRole("dialog"));
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "فعال نکن" })); });
  await eventually(() => screen.getByText(/پیگیری فعال نشد/));
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
