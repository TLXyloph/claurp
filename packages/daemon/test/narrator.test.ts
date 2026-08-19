import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@claurp/protocol";
import { Narrator, type Verbosity } from "../src/narrator.js";
import type { UsageSummary } from "../src/meter.js";

const LABEL = "auth refactor";

const EVENTS = {
  started: { kind: "started", backendSessionId: null },
  textDelta: { kind: "text-delta", text: "partial output" },
  toolUse: { kind: "tool-use", tool: "Bash", detail: "npm install" },
  needsPermission: { kind: "needs-permission", requestId: "r1", tool: "Bash", detail: "npm install" },
  needsInput: { kind: "needs-input", prompt: "Which file should I edit?" },
  usageMetadata: { kind: "usage-metadata", inputTokens: 100, outputTokens: 10 },
  doneWithSummary: { kind: "done", summary: "All tests pass." },
  doneNoSummary: { kind: "done" },
  error: { kind: "error", message: "network timeout" },
} satisfies Record<string, AgentEvent>;

// Speaking-rules table (task-14-brief.md, Produces block). null = stay quiet.
const TABLE: Array<[Verbosity, keyof typeof EVENTS, string | null]> = [
  // tool-use: only chatty narrates routine tool churn
  ["chatty", "toolUse", "Running Bash."],
  ["normal", "toolUse", null],
  ["quiet", "toolUse", null],
  ["silent", "toolUse", null],

  // needs-input: verbatim read-out of the agent's actual question, everywhere but silent
  ["chatty", "needsInput", "Which file should I edit?"],
  ["normal", "needsInput", "Which file should I edit?"],
  ["quiet", "needsInput", "Which file should I edit?"],
  ["silent", "needsInput", null],

  // done, with a summary: chatty/normal speak it, quiet trims it, silent stays quiet
  ["chatty", "doneWithSummary", "auth refactor: done. All tests pass."],
  ["normal", "doneWithSummary", "auth refactor: done. All tests pass."],
  ["quiet", "doneWithSummary", "auth refactor: done."],
  ["silent", "doneWithSummary", null],

  // done, no summary at all: nothing to trim, so chatty/normal/quiet read the same line
  ["chatty", "doneNoSummary", "auth refactor: done."],
  ["normal", "doneNoSummary", "auth refactor: done."],
  ["quiet", "doneNoSummary", "auth refactor: done."],
  ["silent", "doneNoSummary", null],

  // error: always narrated except silent
  ["chatty", "error", "auth refactor hit an error: network timeout"],
  ["normal", "error", "auth refactor hit an error: network timeout"],
  ["quiet", "error", "auth refactor hit an error: network timeout"],
  ["silent", "error", null],

  // started, text-delta, usage-metadata, needs-permission: null at every verbosity.
  // Permission asks are driven by the policy engine through permissionAsk(), not onEvent().
  ["chatty", "started", null],
  ["normal", "started", null],
  ["quiet", "started", null],
  ["silent", "started", null],
  ["chatty", "textDelta", null],
  ["normal", "textDelta", null],
  ["quiet", "textDelta", null],
  ["silent", "textDelta", null],
  ["chatty", "usageMetadata", null],
  ["normal", "usageMetadata", null],
  ["quiet", "usageMetadata", null],
  ["silent", "usageMetadata", null],
  ["chatty", "needsPermission", null],
  ["normal", "needsPermission", null],
  ["quiet", "needsPermission", null],
  ["silent", "needsPermission", null],
];

describe("Narrator.onEvent", () => {
  it.each(TABLE)("%s / %s -> %j", (verbosity, eventKey, expected) => {
    const narrator = new Narrator({ verbosity });
    expect(narrator.onEvent(LABEL, EVENTS[eventKey])).toBe(expected);
  });
});

describe("Narrator.spawned", () => {
  it("announces the new session at chatty and normal (default)", () => {
    expect(new Narrator({ verbosity: "chatty" }).spawned(LABEL)).toBe("Starting auth refactor.");
    expect(new Narrator().spawned(LABEL)).toBe("Starting auth refactor.");
  });

  it("stays quiet at quiet and silent", () => {
    expect(new Narrator({ verbosity: "quiet" }).spawned(LABEL)).toBeNull();
    expect(new Narrator({ verbosity: "silent" }).spawned(LABEL)).toBeNull();
  });
});

describe("Narrator.permissionAsk", () => {
  it("reads the exact copy for a Bash command (spec §5.4)", () => {
    expect(new Narrator().permissionAsk("Bash", "npm install")).toBe(
      "Claude wants to run npm install — allow?",
    );
  });

  it("still asks, in speakable form, for non-Bash tools", () => {
    const spoken = new Narrator().permissionAsk("Write", "auth.ts");
    expect(spoken).toContain("Write");
    expect(spoken).toContain("auth.ts");
    expect(spoken).toContain("allow?");
  });
});

describe("Narrator.permissionDetail", () => {
  it("wraps the full detail verbatim, for \"what exactly?\"", () => {
    const detail = "npm install --save-dev left-pad@1.3.0";
    expect(new Narrator().permissionDetail(detail)).toContain(detail);
  });
});

describe("Narrator.metaStatus", () => {
  it("is honest about an empty roster", () => {
    expect(new Narrator().metaStatus([])).toBe("No sessions running.");
  });

  it("describes a single session", () => {
    expect(new Narrator().metaStatus([{ label: "auth refactor", state: "working" }])).toBe(
      "auth refactor is working.",
    );
  });

  it("describes every session in a multi-session roster", () => {
    const roster = [
      { label: "auth refactor", state: "working" },
      { label: "flaky test fix", state: "needs-permission" },
    ];
    const spoken = new Narrator().metaStatus(roster);
    expect(spoken).toContain("auth refactor is working");
    expect(spoken).toContain("flaky test fix is needs-permission");
  });
});

describe("Narrator.metaUsage", () => {
  it("reports scope honestly (spec §5.5): what it does and does not cover", () => {
    const usage: UsageSummary = { inputTokens: 1500, outputTokens: 150, costUsd: 0.01, sessions: 2 };
    const spoken = new Narrator().metaUsage(usage);
    expect(spoken).toContain("across claurp sessions");
    expect(spoken.includes("1,500") || spoken.includes("1500")).toBe(true);
    expect(spoken).toContain("2 sessions");
  });
});

describe("Narrator.metaContextFill", () => {
  it("reports a known fill as a human-readable percentage", () => {
    expect(new Narrator().metaContextFill("auth refactor", 0.4)).toContain("40");
  });

  it("is honest about missing data instead of claiming 0%", () => {
    const spoken = new Narrator().metaContextFill("x", null);
    expect(spoken).not.toContain("0%");
    expect(spoken.toLowerCase()).toContain("no data");
  });
});

describe("Narrator.captureUnavailable", () => {
  it("honestly degrades screen capture, naming the next release", () => {
    expect(new Narrator().captureUnavailable("screen")).toContain("next release");
  });

  it("honestly degrades camera capture, naming the next release", () => {
    expect(new Narrator().captureUnavailable("camera")).toContain("next release");
  });
});

describe("Narrator.handoff", () => {
  it("names the exact resume command when one exists", () => {
    expect(new Narrator().handoff("claude --resume abc123")).toContain("claude --resume abc123");
  });

  it("is honest when there is no handoff command", () => {
    const spoken = new Narrator().handoff(null);
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken).not.toContain("null");
  });
});

describe("Narrator.modeChanged", () => {
  it("speaks the new permission mode in plain words", () => {
    expect(new Narrator().modeChanged("auth refactor", "bypassPermissions")).toContain(
      "bypass permissions",
    );
    expect(new Narrator().modeChanged("auth refactor", "plan")).toContain("plan mode");
  });
});

describe("Narrator.bypassConfirmNeeded", () => {
  it("asks for the confirm-bypass phrase (spec §5.3)", () => {
    expect(new Narrator().bypassConfirmNeeded()).toContain("confirm bypass");
  });
});
