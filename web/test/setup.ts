/**
 * DOM for UI tests (happy-dom). Bun's own fetch/stream classes are kept: the tests drive the real PEYVA server
 * in-process, and the server needs Bun's Request/Response.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const keep = ["fetch", "Request", "Response", "Headers", "ReadableStream", "WritableStream", "TransformStream", "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "URL", "URLSearchParams", "FormData", "Blob"] as const;
const saved = Object.fromEntries(keep.map((k) => [k, (globalThis as Record<string, unknown>)[k]]));
GlobalRegistrator.register({ url: "http://127.0.0.1:4317/" });
for (const k of keep) (globalThis as Record<string, unknown>)[k] = saved[k];
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
