import { describe, expect, it } from "vitest";
import type { Intent } from "@claurp/protocol";
import { parseIntent } from "../src/router.js";

const cases: Array<[string, Intent]> = [
  ["allow", { kind: "permission", decision: "allow" }],
  ["Yes.", { kind: "permission", decision: "allow" }],
  ["deny", { kind: "permission", decision: "deny" }],
  ["no", { kind: "permission", decision: "deny" }],
  ["allow always", { kind: "permission", decision: "always" }],
  ["always allow", { kind: "permission", decision: "always" }],
  ["what exactly?", { kind: "permission", decision: "detail" }],
  ["plan mode", { kind: "mode", mode: "plan", confirmed: true }],
  ["auto accept edits", { kind: "mode", mode: "acceptEdits", confirmed: true }],
  ["auto-accept edits", { kind: "mode", mode: "acceptEdits", confirmed: true }],
  ["normal mode", { kind: "mode", mode: "default", confirmed: true }],
  ["bypass permissions", { kind: "mode", mode: "bypassPermissions", confirmed: false }],
  ["confirm bypass", { kind: "mode", mode: "bypassPermissions", confirmed: true }],
  ["status", { kind: "meta", query: "status" }],
  ["what's the status?", { kind: "meta", query: "status" }],
  ["how much have I used this week", { kind: "meta", query: "usage" }],
  ["usage", { kind: "meta", query: "usage" }],
  ["how full is this session", { kind: "meta", query: "contextFill" }],
  ["new task: fix the flaky test", { kind: "session", op: "new", prompt: "fix the flaky test" }],
  ["kill it", { kind: "session", op: "kill" }],
  ["stop that", { kind: "session", op: "kill" }],
  ["switch to the auth one", { kind: "session", op: "switch", target: "the auth one" }],
  ["show me the session", { kind: "session", op: "handoff" }],
  ["open it in the terminal", { kind: "session", op: "handoff" }],
  ["look at my screen", { kind: "capture", target: "screen" }],
  ["check this out", { kind: "capture", target: "camera" }],
  ["refactor the auth flow and add tests", { kind: "prompt", text: "refactor the auth flow and add tests" }],
  // spec §5.1: leading "in <project-name>," routes by named project
  ["in dotfiles, update my zsh aliases", { kind: "prompt", text: "update my zsh aliases", project: "dotfiles" }],
  ["in notes new task: draft the readme", { kind: "session", op: "new", prompt: "draft the readme", project: "notes" }],
  ["in dotfiles, status", { kind: "meta", query: "status" }],   // project prefix ignored for non-prompt intents
];

describe("parseIntent", () => {
  it.each(cases)("%s", (text, expected) => {
    expect(parseIntent(text)).toEqual(expected);
  });

  it("treats near-miss verbs as prompts (no fuzzy guessing in v0.1)", () => {
    expect(parseIntent("please allow more logging in the app")).toEqual({
      kind: "prompt",
      text: "please allow more logging in the app",
    });
  });
});
