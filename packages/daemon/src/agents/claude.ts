import { randomUUID } from "node:crypto";
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentEvent,
  ContentBlock,
  PermissionMode,
  SessionHandle,
  SpawnOpts,
} from "@claurp/protocol";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { EventQueue } from "./queue.js";

/**
 * Test seam: the shape of the SDK's `query()` entry point, narrowed to what
 * this adapter needs. Real messages/options are `unknown`-typed here and
 * mapped at runtime — see `handleMessage` — because the frozen mocked test
 * (`claude.test.ts`) scripts raw plain objects rather than real SDK types.
 */
export type QueryFn = (args: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => AsyncGenerator<unknown> & {
  interrupt?(): Promise<unknown>;
  setPermissionMode?(mode: string): Promise<void>;
};

const defaultQueryFn: QueryFn = (args) => {
  const q = sdkQuery({
    prompt: args.prompt as AsyncIterable<SDKUserMessage>,
    options: args.options as Options,
  });
  return q as unknown as AsyncGenerator<unknown> & {
    interrupt?(): Promise<unknown>;
    setPermissionMode?(mode: string): Promise<void>;
  };
};

const CLAUDE_CAPABILITIES: AdapterCapabilities = {
  images: true,
  permissions: "callback",
  resume: true,
  queuedInput: true,
  permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** `input.command` when present, else compact JSON of `input` truncated to 200 chars. */
function formatDetail(input: Record<string, unknown>): string {
  if (typeof input.command === "string") return input.command;
  const json = JSON.stringify(input);
  return json.length > 200 ? json.slice(0, 200) : json;
}

function toSdkContent(blocks: ContentBlock[]): unknown[] {
  return blocks.map((b) =>
    b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.base64 } },
  );
}

/**
 * Minimal push-queue of outgoing SDK user turns feeding the `prompt` async
 * generator handed to `queryFn`. Distinct from `EventQueue`: it carries raw
 * SDK-shaped messages outbound, not `AgentEvent`s inbound.
 */
class SendQueue {
  private buf: unknown[] = [];
  private waiters: Array<(v: IteratorResult<unknown>) => void> = [];
  private closed = false;

  push(v: unknown): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false }); else this.buf.push(v);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        if (this.buf.length > 0) return Promise.resolve({ value: this.buf.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

class ClaudeSessionHandle implements SessionHandle {
  private readonly queue = new EventQueue();
  private readonly sendQueue = new SendQueue();
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; input: Record<string, unknown> }>();
  private readonly session: ReturnType<QueryFn>;
  private backendSessionId: string | null = null;
  private killed = false;
  private warnedNoSetPermissionMode = false;

  constructor(opts: SpawnOpts, queryFn: QueryFn) {
    this.session = queryFn({
      prompt: this.buildPrompt(opts.prompt),
      options: {
        cwd: opts.cwd,
        permissionMode: opts.permissionMode,
        settingSources: ["user", "project", "local"],
        canUseTool: this.canUseTool,
      },
    });
    void this.run();
  }

  private async *buildPrompt(initialText: string): AsyncGenerator<unknown> {
    yield {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: initialText }] },
      parent_tool_use_id: null,
      session_id: "",
    };
    for await (const msg of this.sendQueue) {
      yield msg;
    }
  }

  private canUseTool = async (toolName: string, input: Record<string, unknown>): Promise<unknown> => {
    const requestId = randomUUID();
    this.queue.push({ kind: "needs-permission", requestId, tool: toolName, detail: formatDetail(input) });
    return new Promise((resolve) => {
      this.pending.set(requestId, { resolve, input });
    });
  };

  private async run(): Promise<void> {
    try {
      for await (const raw of this.session) {
        if (this.handleMessage(raw)) break;
      }
    } catch (err) {
      this.queue.push({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.sendQueue.close();
    }
  }

  /** Maps one incoming SDK message to `AgentEvent`(s). Returns true when the session reached a terminal state. */
  private handleMessage(raw: unknown): boolean {
    if (!isRecord(raw) || typeof raw.type !== "string") return false;

    if (raw.type === "system" && raw.subtype === "init") {
      if (typeof raw.session_id === "string") {
        this.backendSessionId = raw.session_id;
        this.queue.push({ kind: "started", backendSessionId: raw.session_id });
      }
      return false;
    }

    if (raw.type === "assistant") {
      const message = isRecord(raw.message) ? raw.message : undefined;
      const content = message && Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (!isRecord(block) || typeof block.type !== "string") continue;
        if (block.type === "text" && typeof block.text === "string") {
          this.queue.push({ kind: "text-delta", text: block.text });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const input = isRecord(block.input) ? block.input : {};
          this.queue.push({ kind: "tool-use", tool: block.name, detail: formatDetail(input) });
        }
      }
      const usage = message && isRecord(message.usage) ? message.usage : undefined;
      if (usage) {
        this.queue.push({
          kind: "usage-metadata",
          inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        });
      }
      return false;
    }

    if (raw.type === "result") {
      const usage = isRecord(raw.usage) ? raw.usage : undefined;
      const costUsd = typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : undefined;
      this.queue.push({
        kind: "usage-metadata",
        inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
        outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : 0,
        ...(costUsd !== undefined ? { costUsd } : {}),
      });

      const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
      if (subtype.startsWith("error")) {
        const message =
          Array.isArray(raw.errors) && raw.errors.length > 0
            ? raw.errors.filter((e): e is string => typeof e === "string").join("; ")
            : `claude session ended: ${subtype}`;
        this.queue.push({ kind: "error", message });
      } else {
        const summary = typeof raw.result === "string" ? raw.result.slice(0, 120) : undefined;
        this.queue.push({ kind: "done", summary });
      }
      return true;
    }

    // Unknown/forward-compatible message types (partial streams, task notifications, etc.) are ignored.
    return false;
  }

  send(blocks: ContentBlock[]): void {
    this.sendQueue.push({
      type: "user",
      message: { role: "user", content: toSdkContent(blocks) },
      parent_tool_use_id: null,
      session_id: "",
    });
  }

  interrupt(): void {
    if (typeof this.session.interrupt === "function") void this.session.interrupt();
  }

  setPermissionMode(mode: PermissionMode): void {
    if (typeof this.session.setPermissionMode === "function") {
      void this.session.setPermissionMode(mode);
    } else if (!this.warnedNoSetPermissionMode) {
      this.warnedNoSetPermissionMode = true;
      console.warn("[claude-adapter] setPermissionMode is not supported by this query object; ignoring");
    }
  }

  respondPermission(requestId: string, decision: "allow" | "deny"): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    if (decision === "allow") {
      entry.resolve({ behavior: "allow", updatedInput: entry.input });
    } else {
      entry.resolve({ behavior: "deny", message: "denied by voice" });
    }
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue.iterate();
  }

  handoffCommand(): string | null {
    return this.backendSessionId ? `claude --resume ${this.backendSessionId}` : null;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    if (typeof this.session.interrupt === "function") void this.session.interrupt();
    this.sendQueue.close();
    this.queue.close();
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = "claude";
  private readonly queryFn: QueryFn;

  constructor(opts?: { queryFn?: QueryFn }) {
    this.queryFn = opts?.queryFn ?? defaultQueryFn;
  }

  capabilities(): AdapterCapabilities {
    return CLAUDE_CAPABILITIES;
  }

  spawn(opts: SpawnOpts): SessionHandle {
    return new ClaudeSessionHandle(opts, this.queryFn);
  }
}
