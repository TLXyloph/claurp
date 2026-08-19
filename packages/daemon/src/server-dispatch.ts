// Intent dispatch: turns a parsed `Intent` (Task 8) into SessionManager/PermissionPolicy/
// MeterService/Narrator calls and a spoken response, per the dispatch-contract table in
// task-16-brief.md. Deliberately free of WS/pipeline/TTS-streaming mechanics -- those live in
// server.ts, which supplies this module a small callback surface (`DispatchContext`) instead.
import type { Intent } from "@claurp/protocol";
import type { MeterService } from "./meter.js";
import type { Narrator } from "./narrator.js";
import type { PermissionPolicy } from "./policy.js";
import type { Project } from "./sessions/projects.js";
import type { SessionManager, SessionRecord } from "./sessions/manager.js";

export interface DispatchContext {
  manager: SessionManager;
  projects: { defaultProject: Project; byName: Map<string, Project> };
  policy: PermissionPolicy;
  meter: MeterService;
  narrator: Narrator;
  // Fire-and-forget: streams `text` to TTS as it goes. `null` is a no-op (mirrors Narrator's
  // "stay quiet" convention throughout).
  speak: (text: string | null) => void;
  // Spawns a session AND starts its event pump (server.ts owns the pump loop, since it needs
  // access to broadcast/tts machinery this module doesn't have). Returns synchronously --
  // SessionManager.spawn() itself is synchronous.
  spawn: (prompt: string, project: Project) => SessionRecord;
  runHandoffTerminal: (cmd: string) => void;
}

type PermissionDecision = "allow" | "deny" | "always" | "detail";

/** Shared by the voice `permission/*` intent (acting on the focused session) and the WS
 *  `permission.response` handler (acting on an explicit session) -- see server.ts. */
export function applyPermissionDecision(
  record: SessionRecord,
  decision: PermissionDecision,
  ctx: Pick<DispatchContext, "manager" | "policy" | "narrator" | "speak">,
): void {
  const pending = record.pendingPermission;
  if (!pending) {
    ctx.speak("Nothing is waiting on permission.");
    return;
  }
  switch (decision) {
    case "allow":
      ctx.manager.respondPermission(record.id, "allow");
      return;
    case "deny":
      ctx.manager.respondPermission(record.id, "deny");
      return;
    case "always": {
      const ok = ctx.policy.recordAlways(pending.tool, pending.detail);
      if (!ok) {
        ctx.speak("That one can't be always-allowed.");
        return;
      }
      ctx.manager.respondPermission(record.id, "allow");
      return;
    }
    case "detail":
      ctx.speak(ctx.narrator.permissionDetail(pending.detail));
      return;
  }
}

function resolveNamedProject(ctx: DispatchContext, name: string): Project | null {
  return ctx.projects.byName.get(name) ?? null;
}

/** Fix round (Minor): a session doesn't stop being voice-immutable just because it finished
 *  normally -- one that's been handed off to a terminal (spec §5.3) is now driven from there,
 *  so `mode`/`handoff` voice commands must refuse it exactly like a done/failed one. Returns
 *  the honest refusal to speak, or `null` if the session is still voice-mutable. */
function voiceImmutableRefusal(record: SessionRecord): string | null {
  if (record.state === "done" || record.state === "failed") return `${record.label} already finished.`;
  if (record.state === "handed-off") return `${record.label} is in your terminal now.`;
  return null;
}

/** Resolves the project for `prompt`/`session-new` intents. Returns `null` (having already
 *  spoken the honest "no such project" refusal) when a named project doesn't exist. */
function resolveProjectOrRefuse(ctx: DispatchContext, name: string | undefined): Project | null {
  if (!name) return ctx.projects.defaultProject;
  const project = resolveNamedProject(ctx, name);
  if (!project) {
    ctx.speak(`No project named ${name}.`);
    return null;
  }
  return project;
}

function dispatchPrompt(intent: { text: string; project?: string }, ctx: DispatchContext): void {
  const project = resolveProjectOrRefuse(ctx, intent.project);
  if (!project) return;

  const focused = ctx.manager.focused();
  const focusedActive = focused !== null && (focused.state === "working" || focused.state === "needs-input");
  if (intent.project || !focusedActive) {
    const record = ctx.spawn(intent.text, project);
    ctx.speak(ctx.narrator.spawned(record.label));
  } else {
    focused!.handle.send([{ type: "text", text: intent.text }]);
  }
}

function dispatchSession(intent: Extract<Intent, { kind: "session" }>, ctx: DispatchContext): void {
  switch (intent.op) {
    case "new": {
      const project = resolveProjectOrRefuse(ctx, intent.project);
      if (!project) return;
      const record = ctx.spawn(intent.prompt, project);
      ctx.speak(ctx.narrator.spawned(record.label));
      return;
    }
    case "status": {
      ctx.speak(ctx.narrator.metaStatus(ctx.manager.roster().map((r) => ({ label: r.label, state: r.state }))));
      return;
    }
    case "switch": {
      const hit = ctx.manager.switchTo(intent.target);
      ctx.speak(hit ? `Focused on ${hit.label}.` : `No session matching ${intent.target}.`);
      return;
    }
    case "kill": {
      const focused = ctx.manager.focused();
      if (!focused) {
        ctx.speak("Nothing to stop.");
        return;
      }
      ctx.manager.kill(focused.id);
      ctx.speak(`${focused.label} stopped.`);
      return;
    }
    case "handoff": {
      const focused = ctx.manager.focused();
      if (!focused) {
        ctx.speak("No session to hand off.");
        return;
      }
      // Carry-forward: handoff() has NO terminal guard -- check state ourselves first.
      const refusal = voiceImmutableRefusal(focused);
      if (refusal) {
        ctx.speak(refusal);
        return;
      }
      const cmd = ctx.manager.handoff(focused.id);
      if (cmd) ctx.runHandoffTerminal(cmd);
      ctx.speak(ctx.narrator.handoff(cmd));
      return;
    }
  }
}

function dispatchPermission(intent: Extract<Intent, { kind: "permission" }>, ctx: DispatchContext): void {
  const focused = ctx.manager.focused();
  if (!focused) {
    ctx.speak("Nothing is waiting on permission.");
    return;
  }
  applyPermissionDecision(focused, intent.decision, ctx);
}

function dispatchMode(intent: Extract<Intent, { kind: "mode" }>, ctx: DispatchContext): void {
  if (!intent.confirmed) {
    ctx.speak(ctx.narrator.bypassConfirmNeeded());
    return;
  }
  const focused = ctx.manager.focused();
  if (!focused) {
    ctx.speak("No active session.");
    return;
  }
  // Carry-forward: setPermissionMode() has NO terminal guard -- check state ourselves first.
  const refusal = voiceImmutableRefusal(focused);
  if (refusal) {
    ctx.speak(refusal);
    return;
  }
  // Review fix (Important, documentation only -- accepted v0.1 limitation, no behavior
  // change): when intent.mode === "bypassPermissions", the Claude Agent SDK does not invoke
  // `canUseTool` at all in that mode, so PermissionPolicy's hardDeny() list (server.ts's
  // pumpSession() -> policy.decide()) is never consulted for anything the agent does next --
  // a destructive command like `rm -rf /` would run unmediated. The daemon architecturally
  // cannot enforce the deny-list backstop once a session is in bypass mode; it can only gate
  // entry into that mode (this line requires an explicit prior spoken "confirm bypass" --
  // `intent.confirmed` above -- and the narrator's `bypassConfirmNeeded()` warns before that).
  // v0.1 keeps bypass anyway: it's a legitimate, existing Claude Code mode, and refusing to
  // ever set it would make claurp less capable than typing the same command directly in a
  // terminal. Documented as a known limitation in spec §5.4, not silently accepted.
  ctx.manager.setPermissionMode(focused.id, intent.mode);
  ctx.speak(ctx.narrator.modeChanged(focused.label, intent.mode));
}

function dispatchMeta(intent: Extract<Intent, { kind: "meta" }>, ctx: DispatchContext): void {
  switch (intent.query) {
    case "status":
      ctx.speak(ctx.narrator.metaStatus(ctx.manager.roster().map((r) => ({ label: r.label, state: r.state }))));
      return;
    case "usage":
      ctx.speak(ctx.narrator.metaUsage(ctx.meter.summary("week")));
      return;
    case "contextFill": {
      const focused = ctx.manager.focused();
      if (!focused) {
        ctx.speak("No active session.");
        return;
      }
      ctx.speak(ctx.narrator.metaContextFill(focused.label, ctx.meter.contextFill(focused.id)));
      return;
    }
  }
}

export function dispatchIntent(intent: Intent, ctx: DispatchContext): void {
  switch (intent.kind) {
    case "prompt":
      dispatchPrompt(intent, ctx);
      return;
    case "session":
      dispatchSession(intent, ctx);
      return;
    case "permission":
      dispatchPermission(intent, ctx);
      return;
    case "mode":
      dispatchMode(intent, ctx);
      return;
    case "meta":
      dispatchMeta(intent, ctx);
      return;
    case "capture":
      ctx.speak(ctx.narrator.captureUnavailable(intent.target));
      return;
  }
}
