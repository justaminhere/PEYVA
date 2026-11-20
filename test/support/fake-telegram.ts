/** TEST-ONLY fake Telegram Bot API (getMe, getUpdates, sendMessage). Nothing leaves the machine. */
export function fakeTelegram(token: string) {
  const state = {
    updates: [] as unknown[],
    sent: [] as { chat_id: number; text: string }[],
    sendMode: "ok" as "ok" | "forbidden" | "rate_limited" | "slow" | "server_error",
    nextUpdateId: Date.now() % 1_000_000_000, // real update ids only grow; each fake server starts higher
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const [, bot, method] = url.pathname.split("/");
      if (bot !== `bot${token}`) return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
      const body = (await req.json().catch(() => ({}))) as Record<string, any>;
      if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "peyva_test_bot" } });
      if (method === "getUpdates") return Response.json({ ok: true, result: state.updates.filter((u: any) => u.update_id >= (body.offset ?? 0)) });
      if (method === "sendMessage") {
        if (state.sendMode === "forbidden") return Response.json({ ok: false, description: `Forbidden: bot was blocked by the user (token ${token})` }, { status: 403 });
        if (state.sendMode === "rate_limited") return Response.json({ ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } }, { status: 429 });
        if (state.sendMode === "server_error") return Response.json({ ok: false, description: "Bad Gateway" }, { status: 502 });
        if (state.sendMode === "slow") await Bun.sleep(1_500);
        state.sent.push({ chat_id: body.chat_id, text: body.text });
        return Response.json({ ok: true, result: { message_id: state.sent.length } });
      }
      return Response.json({ ok: false, description: "not found" }, { status: 404 });
    },
  });
  return {
    state, url: `http://127.0.0.1:${server.port}`,
    userSends(chatId: number, text: string, type = "private") { state.updates.push({ update_id: state.nextUpdateId++, message: { text, chat: { id: chatId, type }, from: { id: chatId } } }); },
    stop: () => server.stop(true),
  };
}
