import type {
  AgentAdapter,
  AgentEvent,
  AdapterCapabilities,
  ContentBlock,
  SessionHandle,
  SpawnOpts,
} from "@claurp/protocol";
import type { PermissionMode } from "@claurp/protocol";
import { EventQueue } from "./queue.js";

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
