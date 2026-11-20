/** Provider-independent LLM contract: chat messages + function tools. */
export interface ToolCall { id: string; name: string; arguments: string }

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export type LlmErrorCause = "config" | "auth" | "rate_limit" | "timeout" | "network" | "bad_request" | "malformed" | "provider";

export type LlmResponse =
  | { ok: true; text: string | null; toolCalls: ToolCall[]; finishReason: string | null; model: string | null; usage?: { prompt: number | null; completion: number | null } }
  | { ok: false; cause: LlmErrorCause; message: string };

export interface LlmClient {
  /** Human label for logs, e.g. "openai-compatible:gpt-x@api.example.com". Never contains secrets. */
  readonly label: string;
  complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<LlmResponse>;
  /**
   * Same contract as complete(), but text is reported to onText as the provider produces it.
   * The resolved response is the complete, authoritative result (tool calls fully assembled).
   */
  stream?(messages: ChatMessage[], tools: ToolSpec[], onText: (delta: string) => void): Promise<LlmResponse>;
}
