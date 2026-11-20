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
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) return { ok: false, cause: "auth", message: msg };
  if (e instanceof OpenAI.RateLimitError) return { ok: false, cause: "rate_limit", message: msg };
  if (e instanceof OpenAI.BadRequestError || e instanceof OpenAI.NotFoundError || e instanceof OpenAI.UnprocessableEntityError) return { ok: false, cause: "bad_request", message: msg };
  if (e instanceof OpenAI.APIError) return { ok: false, cause: "provider", message: msg };
  return { ok: false, cause: "malformed", message: msg };
}
