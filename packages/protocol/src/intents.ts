export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type Intent =
  | { kind: "prompt"; text: string; project?: string }
  | { kind: "session"; op: "new"; prompt: string; project?: string }
  | { kind: "session"; op: "status" | "kill" | "handoff" }
  | { kind: "session"; op: "switch"; target: string }
  | { kind: "permission"; decision: "allow" | "deny" | "always" | "detail" }
  | { kind: "mode"; mode: PermissionMode; confirmed: boolean }
  | { kind: "meta"; query: "usage" | "contextFill" | "status" }
  | { kind: "capture"; target: "screen" | "camera" };
