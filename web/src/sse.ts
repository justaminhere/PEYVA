/** Minimal Server-Sent Events reader for fetch() responses (EventSource cannot POST). */
export interface SseMessage { event: string; data: string }

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue; // comment / keep-alive ping
        const k = line.indexOf(":");
        const field = k < 0 ? line : line.slice(0, k);
        const val = k < 0 ? "" : line.slice(k + 1).replace(/^ /, "");
        if (field === "event") event = val;
        else if (field === "data") data.push(val);
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
    if (done) return;
  }
}
