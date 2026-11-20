/** Runtime configuration from environment variables (Bun loads .env automatically). Secrets are never logged. */
export interface LlmConfig { baseURL: string; apiKey: string; model: string; timeoutMs: number }

export type ConfigResult = { ok: true; llm: LlmConfig } | { ok: false; missing: string[]; problems: string[] };

export function loadLlmConfig(env: Record<string, string | undefined> = process.env): ConfigResult {
  const missing: string[] = [];
  const problems: string[] = [];
  const baseURL = env.PEYVA_LLM_BASE_URL?.trim() ?? "";
  const apiKey = env.PEYVA_LLM_API_KEY?.trim() ?? "";
  const model = env.PEYVA_LLM_MODEL?.trim() ?? "";
  if (!baseURL) missing.push("PEYVA_LLM_BASE_URL");
  if (!apiKey) missing.push("PEYVA_LLM_API_KEY");
  if (!model) missing.push("PEYVA_LLM_MODEL");
  if (baseURL) {
    try {
      const u = new URL(baseURL);
      if (u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) problems.push("PEYVA_LLM_BASE_URL must use https (http only for localhost)");
    } catch { problems.push("PEYVA_LLM_BASE_URL is not a valid URL"); }
  }
  const timeoutMs = Number(env.PEYVA_LLM_TIMEOUT_MS ?? 45_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) problems.push("PEYVA_LLM_TIMEOUT_MS must be 1000..300000");
  if (missing.length || problems.length) return { ok: false, missing, problems };
  return { ok: true, llm: { baseURL, apiKey, model, timeoutMs } };
}

/** For display: host and model only. */
export function describeLlm(c: LlmConfig): string {
  return `${c.model} @ ${new URL(c.baseURL).host}`;
}
