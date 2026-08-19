import type { PermissionMode } from "./intents.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg"; base64: string }; // v0.2 uses images; v0.1 sends text only

export type AgentEvent =
  | { kind: "started"; backendSessionId: string | null }
  | { kind: "text-delta"; text: string }
  | { kind: "tool-use"; tool: string; detail: string }
  | { kind: "needs-permission"; requestId: string; tool: string; detail: string }
  | { kind: "needs-input"; prompt: string }
  | { kind: "usage-metadata"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { kind: "done"; summary?: string }
  | { kind: "error"; message: string };

export interface SpawnOpts { cwd: string; prompt: string; permissionMode: PermissionMode }

export interface SessionHandle {
  send(blocks: ContentBlock[]): void;
  interrupt(): void;
  setPermissionMode(mode: PermissionMode): void;
  respondPermission(requestId: string, decision: "allow" | "deny"): void;
  events(): AsyncIterable<AgentEvent>;
  handoffCommand(): string | null;
  kill(): void;
}

export interface AdapterCapabilities {
  images: boolean;
  permissions: "callback" | "flags" | "none";
  resume: boolean;
  queuedInput: boolean;
  permissionModes: PermissionMode[];
}

export interface AgentAdapter {
  readonly name: string;
  capabilities(): AdapterCapabilities;
  spawn(opts: SpawnOpts): SessionHandle;
}
