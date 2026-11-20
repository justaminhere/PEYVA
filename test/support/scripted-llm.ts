/**
 * TEST-ONLY LLM. Replays a fixed script of responses so the agent loop can be tested deterministically.
 * It is never imported by src/; the CLI refuses to start without a real configured LLM.
 */
import type { ChatMessage, LlmClient, LlmResponse, ToolCall, ToolSpec } from "../../src/llm/types.ts";

export type Step = LlmResponse | ((messages: ChatMessage[]) => LlmResponse);
let n = 0;
export const call = (name: string, args: unknown): ToolCall => ({ id: `call_${++n}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
export const tools = (...calls: ToolCall[]): LlmResponse => ({ ok: true, text: null, toolCalls: calls, finishReason: "tool_calls", model: "scripted" });
export const say = (text: string): LlmResponse => ({ ok: true, text, toolCalls: [], finishReason: "stop", model: "scripted" });

export class ScriptedLlm implements LlmClient {
  readonly label = "TEST-ONLY scripted LLM";
  requests: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];
  constructor(private steps: Step[]) {}
  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<LlmResponse> {
    this.requests.push({ messages: structuredClone(messages), tools });
    const s = this.steps.shift();
    if (!s) throw new Error("ScriptedLlm: script exhausted");
    return typeof s === "function" ? s(messages) : s;
  }
}

/** TEST-ONLY: the same script, delivered through the streaming interface (text split into small deltas). */
export class ScriptedStreamingLlm extends ScriptedLlm {
  async stream(messages: ChatMessage[], tools: ToolSpec[], onText: (d: string) => void): Promise<LlmResponse> {
    const r = await this.complete(messages, tools);
    if (r.ok && r.text) for (const part of r.text.match(/.{1,4}/gsu) ?? []) onText(part);
    return r;
  }
}
