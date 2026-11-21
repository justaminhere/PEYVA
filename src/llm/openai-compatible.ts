/**
 * The one real LLM adapter: any OpenAI-compatible Chat Completions endpoint with function calling,
 * via the official `openai` SDK. Errors are mapped to LlmErrorCause; nothing here throws to callers.
 */
import OpenAI from "openai";
import type { ChatMessage, LlmClient, LlmResponse, ToolSpec } from "./types.ts";
import { describeLlm, type LlmConfig } from "../config.ts";

export class OpenAICompatibleClient implements LlmClient {
  readonly label: string;
  private client: OpenAI;
  constructor(private cfg: LlmConfig) {
    this.label = `openai-compatible:${describeLlm(cfg)}`;
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: cfg.timeoutMs, maxRetries: 1 });
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<LlmResponse> {
    try {
      const res = await this.client.chat.completions.create({
        model: this.cfg.model,
        temperature: 0,
        messages: messages.map(toOpenAI),
        ...(tools.length ? { tools: tools.map((t) => ({ type: "function" as const, function: t })), tool_choice: "auto" as const } : {}),
      });
      const choice = res.choices?.[0];
      if (!choice?.message) return { ok: false, cause: "malformed", message: "response has no message" };
      const calls = (choice.message.tool_calls ?? []).flatMap((c) =>
        c.type === "function" ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments ?? "" }] : []);
      return { ok: true, text: choice.message.content ?? null, toolCalls: calls, finishReason: choice.finish_reason ?? null, model: res.model ?? null,
        usage: { prompt: res.usage?.prompt_tokens ?? null, completion: res.usage?.completion_tokens ?? null } };
    } catch (e) {
      return mapError(e);
    }
  }

  /**
   * Streaming variant (Server-Sent Events from the provider). Text deltas go to onText; tool-call fragments are
   * assembled by index. If the provider rejects streaming itself before sending anything, falls back to complete().
   */
  async stream(messages: ChatMessage[], tools: ToolSpec[], onText: (delta: string) => void): Promise<LlmResponse> {
    let sentAny = false;
    try {
      const stream = await this.client.chat.completions.create({
        model: this.cfg.model,
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true },
        messages: messages.map(toOpenAI),
        ...(tools.length ? { tools: tools.map((t) => ({ type: "function" as const, function: t })), tool_choice: "auto" as const } : {}),
      });
      let text = "";
      let finish: string | null = null;
      let model: string | null = null;
      let usage: { prompt: number | null; completion: number | null } | undefined;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const chunk of stream) {
        model ??= chunk.model ?? null;
        const u = chunk.usage ?? (chunk as { x_groq?: { usage?: typeof chunk.usage } }).x_groq?.usage;
        if (u) usage = { prompt: u.prompt_tokens ?? null, completion: u.completion_tokens ?? null };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const d = choice.delta;
        if (d?.content) { text += d.content; sentAny = true; onText(d.content); }
        for (const tc of d?.tool_calls ?? []) {
          sentAny = true;
          const cur = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          calls.set(tc.index, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).filter((c) => c.name);
      if (!text && !toolCalls.length && !finish) return { ok: false, cause: "malformed", message: "stream ended without content" };
      return { ok: true, text: text || null, toolCalls, finishReason: finish, model, usage };
    } catch (e) {
      const mapped = mapError(e);
      // e.g. a provider that does not support stream_options: try the non-streaming request once.
      if (!sentAny && !mapped.ok && mapped.cause === "bad_request" && /stream/i.test(mapped.message)) return this.complete(messages, tools);
      return mapped;
    }
  }
}

function toOpenAI(m: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (m.role) {
    case "assistant":
      return { role: "assistant", content: m.content, ...(m.toolCalls?.length ? {
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
      } : {}) };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}

export function mapError(e: unknown): LlmResponse {
  const msg = (e as Error)?.message?.slice(0, 300) ?? String(e);
  if (e instanceof OpenAI.APIConnectionTimeoutError) return { ok: false, cause: "timeout", message: msg };
  if (e instanceof OpenAI.APIConnectionError) return { ok: false, cause: "network", message: msg };
  if (e instanceof OpenAI.AuthenticationError) return { ok: false, cause: "auth", message: msg }; // 401: the key itself
  // 403: the key is known but this request is refused, e.g. a model it may not use, or a region the provider blocks.
  if (e instanceof OpenAI.PermissionDeniedError) return { ok: false, cause: "forbidden", message: msg };
  if (e instanceof OpenAI.RateLimitError) return { ok: false, cause: "rate_limit", message: msg };
  if (e instanceof OpenAI.BadRequestError || e instanceof OpenAI.NotFoundError || e instanceof OpenAI.UnprocessableEntityError) return { ok: false, cause: "bad_request", message: msg };
  if (e instanceof OpenAI.APIError) return { ok: false, cause: "provider", message: msg };
  return { ok: false, cause: "malformed", message: msg };
}
