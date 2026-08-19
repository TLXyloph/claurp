import type {
  AgentAdapter,
  AgentEvent,
  AdapterCapabilities,
  ContentBlock,
  SessionHandle,
  SpawnOpts,
} from "@claurp/protocol";
import type { PermissionMode } from "@claurp/protocol";

/**
 * Internal push-queue backing `SessionHandle.events()`. An async iterator
 * drains events as they are pushed and closes automatically after a
 * terminal `done`/`error` event (or an explicit `close()`, e.g. on `kill()`).
 */
class EventQueue {
  private buf: AgentEvent[] = [];
  private waiters: Array<(v: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;
  push(e: AgentEvent): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: e, done: false }); else this.buf.push(e);
    if (e.kind === "done" || e.kind === "error") this.close();
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  iterate(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<AgentEvent>> => {
          const e = this.buf.shift();
          if (e) return Promise.resolve({ value: e, done: false });
          if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((res) => this.waiters.push(res));
        },
      }),
    };
  }
}

const FAKE_CAPABILITIES: AdapterCapabilities = {
  images: false,
  permissions: "callback",
  resume: false,
  queuedInput: true,
  permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
};

class FakeSessionHandle implements SessionHandle {
  private readonly queue = new EventQueue();
  private readonly permissionMode: PermissionMode;
  private killed = false;

  constructor(opts: SpawnOpts) {
    this.permissionMode = opts.permissionMode;
    this.run();
  }

  private run(): void {
    this.queue.push({ kind: "started", backendSessionId: null });
    this.queue.push({ kind: "tool-use", tool: "Write", detail: "write notes.txt" });
    if (this.permissionMode === "acceptEdits" || this.permissionMode === "bypassPermissions") {
      this.finish("allow");
      return;
    }
    this.queue.push({ kind: "needs-permission", requestId: "r1", tool: "Write", detail: "write notes.txt" });
  }

  private finish(decision: "allow" | "deny"): void {
    if (decision === "allow") {
      this.queue.push({ kind: "text-delta", text: "Created notes.txt with a haiku." });
      this.queue.push({ kind: "usage-metadata", inputTokens: 1200, outputTokens: 80, costUsd: 0.01 });
      this.queue.push({ kind: "done", summary: "created notes.txt" });
    } else {
      this.queue.push({ kind: "text-delta", text: "Okay, skipping that." });
      this.queue.push({ kind: "done" });
    }
  }

  send(blocks: ContentBlock[]): void {
    const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ").trim();
    this.queue.push({ kind: "text-delta", text: `noted: ${text}` });
  }

  interrupt(): void {
    // No-op for the fake adapter: nothing async to cancel mid-flight.
  }

  setPermissionMode(_mode: PermissionMode): void {
    // No-op: the fake's script is fixed at spawn time.
  }

  respondPermission(requestId: string, decision: "allow" | "deny"): void {
    if (requestId !== "r1") return;
    this.finish(decision);
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue.iterate();
  }

  handoffCommand(): string | null {
    return null;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.queue.close();
  }
}

export class FakeAgent implements AgentAdapter {
  readonly name = "fake";

  capabilities(): AdapterCapabilities {
    return FAKE_CAPABILITIES;
  }

  spawn(opts: SpawnOpts): SessionHandle {
    return new FakeSessionHandle(opts);
  }
}
