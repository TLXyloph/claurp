// Rule-based narrator (spec §7.2, tier 1 of the three-tier ladder): pure functions over the
// typed event stream and the meter/policy outputs. No I/O, no timers, no LLM -- always present,
// free, local, cannot hallucinate. The higher tiers (local model, API polish) sit in front of
// this one later; this module is the honest fallback they degrade to, so every string here must
// already be true and complete on its own.
//
// Speaking rules (spec §7.2): narrate state changes, questions, and completion; stay silent
// through routine tool churn; verbatim read-out whenever the agent asks an actual question.
// `onEvent`'s per-kind table below is the frozen product copy from task-14-brief.md Step 1.
import type { AgentEvent } from "@claurp/protocol";
import type { UsageSummary } from "./meter.js";

export type Verbosity = "chatty" | "normal" | "quiet" | "silent";

// spec §5.3: the four permission modes, spoken in the same words the router accepts back
// (router.ts matchMode) -- "say 'plan mode'" and "you're in plan mode" should sound like the
// same phrase.
const MODE_NAMES: Record<string, string> = {
  default: "normal mode",
  acceptEdits: "auto-accept edits",
  plan: "plan mode",
  bypassPermissions: "bypass permissions",
};

export class Narrator {
  private readonly verbosity: Verbosity;

  constructor(opts?: { verbosity?: Verbosity }) {
    this.verbosity = opts?.verbosity ?? "normal";
  }

  /** Spoken on session spawn. Silenced at quiet/silent -- spawning is a state change, but at
   *  those dials the user has already said they don't want routine narration. */
  spawned(label: string): string | null {
    if (this.verbosity === "quiet" || this.verbosity === "silent") return null;
    return `Starting ${label}.`;
  }

  /** Speaking-rules table (task-14-brief.md, Produces block). `null` = stay quiet. */
  onEvent(label: string, e: AgentEvent): string | null {
    if (this.verbosity === "silent") return null;

    switch (e.kind) {
      case "tool-use":
        // Routine tool churn: only chatty narrates it, and even then just the tool name.
        return this.verbosity === "chatty" ? `Running ${e.tool}.` : null;

      case "needs-input":
        // Verbatim read-out whenever the agent asks an actual question (spec §7.2) -- every
        // non-silent dial reads it the same way, unmodified.
        return e.prompt;

      case "done":
        if (this.verbosity === "quiet") return `${label}: done.`;
        return e.summary ? `${label}: done. ${e.summary}` : `${label}: done.`;

      case "error":
        return `${label} hit an error: ${e.message}`;

      // started, text-delta, usage-metadata, needs-permission: never narrated here.
      // needs-permission is driven by the policy engine through permissionAsk(), not this table.
      default:
        return null;
    }
  }

  /** The permission ask (spec §5.4). Exact copy for Bash is frozen by task-14-brief.md Step 1:
   *  `permissionAsk("Bash", "npm install")` must equal
   *  "Claude wants to run npm install — allow?" verbatim. Other tools get a speakable form that
   *  still names the tool and the detail, since "run" only reads naturally for a shell command. */
  permissionAsk(tool: string, detail: string): string {
    if (tool === "Bash") return `Claude wants to run ${detail} — allow?`;
    return `Claude wants to use ${tool}: ${detail} — allow?`;
  }

  /** Verbatim wrapper for the "what exactly?" verb (spec §5.4) -- reads the full command back
   *  unmodified, so nothing is paraphrased between what the agent will run and what the user
   *  hears before deciding. */
  permissionDetail(detail: string): string {
    return `The exact command: ${detail}`;
  }

  /** Spoken answer to "status" / "what's the status?" (spec §5.1). Honest about an empty roster
   *  rather than staying silent -- silence would be ambiguous with "I didn't hear you". */
  metaStatus(roster: Array<{ label: string; state: string }>): string {
    if (roster.length === 0) return "No sessions running.";
    if (roster.length === 1) return `${roster[0].label} is ${roster[0].state}.`;
    const parts = roster.map((r) => `${r.label} is ${r.state}`).join("; ");
    return `You have ${roster.length} sessions: ${parts}.`;
  }

  /** Spoken answer to "usage" (spec §5.5). Must say exactly what the number does and does not
   *  cover: this is a rollup of what claurp itself spawned and observed via `usage-metadata`
   *  events, never an implied account-level total -- hence the frozen "across claurp sessions"
   *  phrasing (meter.ts comment: "the narrator (Task 14) owns" it). */
  metaUsage(s: UsageSummary): string {
    const input = s.inputTokens.toLocaleString("en-US");
    const output = s.outputTokens.toLocaleString("en-US");
    const cost = s.costUsd.toFixed(2);
    const sessionWord = s.sessions === 1 ? "session" : "sessions";
    return (
      `${input} input tokens and ${output} output tokens, about $${cost}, ` +
      `across claurp sessions this week — that's ${s.sessions} ${sessionWord} claurp itself ` +
      `spawned. It doesn't cover anything outside what claurp ran.`
    );
  }

  /** Spoken answer to "how full is this session" (spec §5.5). `fill` is null when the meter has
   *  never recorded that session -- that must read as missing data, not as "0% full", which
   *  would claim knowledge the daemon doesn't have. */
  metaContextFill(label: string, fill: number | null): string {
    if (fill === null) return `There's no data yet on how full ${label} is.`;
    const pct = Math.round(fill * 100);
    return `${label} is about ${pct}% full.`;
  }

  /** Honest degrade (spec §6.1/§6.2) for a connector not yet shipped in v0.1 -- says so plainly
   *  rather than staying silent or pretending to try. */
  captureUnavailable(target: "screen" | "camera"): string {
    const label = target === "screen" ? "Screen" : "Camera";
    return `${label} capture arrives in the next release.`;
  }

  /** Spoken answer to "show me the session" / "open it in the terminal" (spec §5.3). `cmd` is
   *  null when the backend has no resumable session (e.g. it never started, or resume isn't
   *  supported) -- that must be said plainly, not papered over. */
  handoff(cmd: string | null): string {
    if (cmd === null) return "This session can't be handed off to a terminal.";
    return `Run "${cmd}" in a terminal to take over that session.`;
  }

  /** Spoken confirmation after a permission-mode switch (spec §5.3), in the same words the
   *  router matches back (see MODE_NAMES). */
  modeChanged(label: string, mode: string): string {
    const spoken = MODE_NAMES[mode] ?? mode;
    return `${label} is now in ${spoken}.`;
  }

  /** Spoken when the user asks for bypass mode without the confirmation phrase yet (spec §5.3:
   *  "bypass requires a spoken confirmation"). */
  bypassConfirmNeeded(): string {
    return "Bypass turns off all permission checks — say 'confirm bypass'.";
  }
}
