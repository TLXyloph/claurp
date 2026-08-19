// Session manager: owns SessionRecord bookkeeping (lifecycle, focus, labels) on top of
// AgentAdapter/SessionHandle (Task 9). Deliberately free of WS/protocol *message* imports --
// it knows adapters and records only; the server layer bridges records to wire messages.
import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentEvent, PermissionMode, SessionHandle } from "@claurp/protocol";
import type { Project } from "./projects.js";

// Label rule (Step 1): lowercase the prompt, drop these stopwords, take the first four
// remaining words. switchTo reuses the same list plus "one" ("the auth one" -> "auth").
const LABEL_STOPWORDS = new Set([
  "the", "a", "an", "please", "claude", "hey", "to", "in", "for", "of", "and",
]);
const SWITCH_STOPWORDS = new Set([...LABEL_STOPWORDS, "one"]);

function labelFromPrompt(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !LABEL_STOPWORDS.has(w));
  const label = words.slice(0, 4).join(" ");
  return label.length > 0 ? label : "task";
}

export interface SessionRecord {
  id: string;
  label: string;
  adapter: string;
  project: Project;
  state: "spawning" | "working" | "needs-permission" | "needs-input" | "done" | "failed" | "handed-off";
  permissionMode: PermissionMode;
  pendingPermission: { requestId: string; tool: string; detail: string } | null;
  handle: SessionHandle;
}

export class SessionManager {
  private readonly adapters: Map<string, AgentAdapter>;
  private readonly defaultAdapter: string;
  private readonly records = new Map<string, SessionRecord>();
  // Unified "attention" clock: bumped on spawn, switchTo, noteActivity, and consume. focused()
  // is whichever session was most recently touched by any of those -- "most recently addressed
  // OR most recently active" collapses to one recency signal shared by both kinds of touch.
  private readonly lastTouch = new Map<string, number>();
  private clock = 0;
  private readonly listeners: Array<(r: SessionRecord) => void> = [];

  constructor(adapters: Map<string, AgentAdapter>, opts: { defaultAdapter: string }) {
    this.adapters = adapters;
    this.defaultAdapter = opts.defaultAdapter;
  }

  spawn(args: { prompt: string; project: Project; permissionMode?: PermissionMode }): SessionRecord {
    const adapterName = this.defaultAdapter;
    const adapter = this.adapters.get(adapterName);
    if (!adapter) throw new Error(`no adapter registered for "${adapterName}"`);

    const permissionMode = args.permissionMode ?? "default";
    const handle = adapter.spawn({ cwd: args.project.cwd, prompt: args.prompt, permissionMode });
    const record: SessionRecord = {
      id: randomUUID(),
      label: labelFromPrompt(args.prompt),
      adapter: adapterName,
      project: args.project,
      state: "spawning",
      permissionMode,
      pendingPermission: null,
      handle,
    };
    this.records.set(record.id, record);
    this.touch(record.id);
    this.emitChange(record);
    return record;
  }

  focused(): SessionRecord | null {
    let best: SessionRecord | null = null;
    let bestTime = -1;
    for (const record of this.records.values()) {
      const t = this.lastTouch.get(record.id) ?? -1;
      if (t > bestTime) {
        bestTime = t;
        best = record;
      }
    }
    return best;
  }

  noteActivity(id: string): void {
    if (!this.records.has(id)) return;
    this.touch(id);
  }

  switchTo(targetText: string): SessionRecord | null {
    const words = targetText
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0 && !SWITCH_STOPWORDS.has(w));
    if (words.length === 0) return null;

    let best: SessionRecord | null = null;
    let bestTime = -1;
    for (const record of this.records.values()) {
      const label = record.label.toLowerCase();
      const matches = words.every((w) => label.includes(w));
      if (!matches) continue;
      const t = this.lastTouch.get(record.id) ?? -1;
      if (t >= bestTime) {
        bestTime = t;
        best = record;
      }
    }
    if (best) this.touch(best.id);
    return best;
  }

  consume(id: string, e: AgentEvent): void {
    const record = this.records.get(id);
    if (!record) return;
    // Terminal is terminal: once "done"/"failed", later events (e.g. drained after kill()) are ignored.
    if (record.state === "done" || record.state === "failed") return;

    switch (e.kind) {
      case "started":
        record.state = "working";
        break;
      case "needs-permission":
        record.state = "needs-permission";
        record.pendingPermission = { requestId: e.requestId, tool: e.tool, detail: e.detail };
        break;
      case "needs-input":
        record.state = "needs-input";
        break;
      case "text-delta":
      case "tool-use":
      case "usage-metadata":
        // State unchanged; still counts as activity via the touch() below.
        break;
      case "done":
        record.state = "done";
        break;
      case "error":
        record.state = "failed";
        break;
    }
    this.touch(id);
    this.emitChange(record);
  }

  respondPermission(id: string, decision: "allow" | "deny"): void {
    const record = this.records.get(id);
    if (!record) return;
    // Terminal sessions cannot be resurrected by a late permission response.
    if (record.state === "done" || record.state === "failed") return;
    const pending = record.pendingPermission;
    if (!pending) return; // no ask outstanding -- complete no-op: no state change/touch/forward/emit

    record.pendingPermission = null;
    record.state = "working";
    record.handle.respondPermission(pending.requestId, decision);
    this.touch(id);
    this.emitChange(record);
  }

  setPermissionMode(id: string, mode: PermissionMode): void {
    const record = this.records.get(id);
    if (!record) return;
    record.permissionMode = mode;
    record.handle.setPermissionMode(mode);
    this.emitChange(record);
  }

  kill(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    // A user-requested stop is a completed lifecycle, not a failure -- the state enum has no
    // "killed", so kill() lands on "done" (terminal; see consume()'s and respondPermission()'s guards).
    record.state = "done";
    record.pendingPermission = null;
    record.handle.kill();
    this.touch(id);
    this.emitChange(record);
  }

  handoff(id: string): string | null {
    const record = this.records.get(id);
    if (!record) return null;
    record.state = "handed-off";
    const command = record.handle.handoffCommand();
    this.emitChange(record);
    return command;
  }

  roster(): SessionRecord[] {
    return [...this.records.values()];
  }

  onChange(cb: (r: SessionRecord) => void): void {
    this.listeners.push(cb);
  }

  private touch(id: string): void {
    this.lastTouch.set(id, ++this.clock);
  }

  private emitChange(record: SessionRecord): void {
    for (const cb of this.listeners) cb(record);
  }
}
