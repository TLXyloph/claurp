import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../src/agents/claude.js";

describe.skipIf(process.env.CLAURP_REAL_CLAUDE !== "1")("ClaudeAdapter real smoke", () => {
  it("runs a trivial real session", async () => {
    const s = new ClaudeAdapter().spawn({
      cwd: mkdtempSync(join(tmpdir(), "claurp-smoke-")),
      prompt: "Reply with exactly the single word: pineapple",
      permissionMode: "default",
    });
    let text = "";
    for await (const e of s.events()) {
      if (e.kind === "text-delta") text += e.text;
      if (e.kind === "done" || e.kind === "error") break;
    }
    expect(text.toLowerCase()).toContain("pineapple");
  }, 300_000);
});
