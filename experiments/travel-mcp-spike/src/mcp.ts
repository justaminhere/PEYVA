import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface LaunchSpec {
  command: string;
  args: string[];
  /** Extra env for the child. Proxy vars are passed through only if explicitly set by the caller. */
  env?: Record<string, string>;
}

export type CallOutcome =
  | { kind: "ok"; latencyMs: number; data: unknown; rawText: string }
  | { kind: "tool_error"; latencyMs: number; message: string; rawText: string }
  | { kind: "timeout"; latencyMs: number; message: string }
  | { kind: "transport_error"; latencyMs: number; message: string };

export class TimeoutError extends Error {}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new TimeoutError(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

export class McpSession {
  private constructor(
    readonly client: Client,
    readonly transport: StdioClientTransport,
    readonly stderr: string[],
  ) {}

  static async open(spec: LaunchSpec, timeoutMs = 90_000): Promise<McpSession> {
    // Only an explicit allowlist of env vars goes to the child: what uvx needs to locate and install
    // the pinned package (PATH, caches, CA bundle, and the system proxy for PyPI), plus caller extras.
    // The upstream servers ignore HTTPS_PROXY for provider traffic by design, so passing it does not
    // change how providers are reached. Provider proxy vars (*_MCP_PROXY) are never set here.
    const env: Record<string, string> = {};
    const pass = /^(PATH|HOME|LANG|LC_ALL|TMPDIR|XDG_CACHE_HOME|UV_[A-Z_]+|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|(https?|all|no)_proxy|(HTTPS?|ALL|NO)_PROXY)$/;
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && pass.test(k) && !/_MCP_PROXY$/.test(k)) env[k] = v;
    }
    Object.assign(env, spec.env ?? {});
    const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env, stderr: "pipe" });
    const stderr: string[] = [];
    transport.stderr?.on("data", (b: Buffer) => {
      stderr.push(b.toString());
      if (stderr.length > 200) stderr.shift();
    });
    const client = new Client({ name: "peyva-travel-mcp-spike", version: "0.1.0" });
    try {
      await withTimeout(client.connect(transport), timeoutMs, `connect ${spec.command} ${spec.args.join(" ")}`);
    } catch (e) {
      await transport.close().catch(() => {});
      throw new Error(`${(e as Error).message}\n--- server stderr (tail) ---\n${stderr.join("").slice(-2000)}`);
    }
    return new McpSession(client, transport, stderr);
  }

  serverInfo() {
    return { server: this.client.getServerVersion(), protocol: (this.transport as any)._protocolVersion ?? null };
  }

  async listTools() {
    const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(this.client.listTools(cursor ? { cursor } : {}), 30_000, "tools/list");
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * Calls a tool and classifies the result. Never throws for tool-level failures:
   * an MCP `isError` result, a timeout and a dead process are distinct outcomes.
   */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<CallOutcome> {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    try {
      const res = await withTimeout(
        this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }),
        timeoutMs + 1_000,
        `tools/call ${name}`,
      );
      const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
      const rawText = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      if (res.isError) return { kind: "tool_error", latencyMs: ms(), message: rawText.slice(0, 2000), rawText };
      let data: unknown = res.structuredContent ?? null;
      if (data === null) {
        try {
          data = JSON.parse(rawText);
        } catch {
          data = rawText;
        }
      }
      return { kind: "ok", latencyMs: ms(), data, rawText };
    } catch (e) {
      const err = e as Error;
      if (err instanceof TimeoutError || /timed out|RequestTimeout|-32001/i.test(err.message))
        return { kind: "timeout", latencyMs: ms(), message: err.message };
      return { kind: "transport_error", latencyMs: ms(), message: err.message };
    }
  }

  async close() {
    await this.client.close().catch(() => {});
  }
}
