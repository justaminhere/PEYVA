/** TEST-ONLY fake OpenAI-compatible endpoint speaking the real streaming wire format (SSE chunks + [DONE]). */
export function fakeOpenAI(script: (body: any) => { status?: number; json?: unknown; chunks?: unknown[] }) {
  const requests: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      requests.push(body);
      const r = script(body);
      if (r.json !== undefined) return Response.json(r.json, { status: r.status ?? 200 });
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(c) {
          for (const ch of r.chunks ?? []) { c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`)); await Bun.sleep(5); }
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}
export const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  ({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
