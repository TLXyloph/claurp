import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@claurp/protocol";
import { ClaudeAdapter } from "../../src/agents/claude.js";
import { adapterContractSuite } from "../../src/agents/contract.js";

type CanUseTool = (tool: string, input: Record<string, unknown>) => Promise<unknown>;

function scriptedQueryFn(capture: { options?: Record<string, unknown> }) {
  return (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    capture.options = args.options;
    async function* gen() {
      yield { type: "system", subtype: "init", session_id: "sess-123" };
      const canUse = args.options.canUseTool as CanUseTool;
      const verdict = (await canUse("Bash", { command: "npm install" })) as { behavior: string };
      if (verdict.behavior === "allow") {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Installing." }, { type: "tool_use", name: "Bash", input: { command: "npm install" } }],
            usage: { input_tokens: 900, output_tokens: 40 },
          },
        };
      }
      yield { type: "result", subtype: "success", result: "All set.", total_cost_usd: 0.02 };
    }
    return Object.assign(gen(), { interrupt: async () => void 0, setPermissionMode: async () => void 0 });
  };
}

adapterContractSuite("claude(mocked)", () => new ClaudeAdapter({ queryFn: scriptedQueryFn({}) }));

describe("ClaudeAdapter mapping", () => {
  it("passes settingSources/cwd/mode and maps the message stream", async () => {
    const capture: { options?: Record<string, unknown> } = {};
    const a = new ClaudeAdapter({ queryFn: scriptedQueryFn(capture) });
    const s = a.spawn({ cwd: "/tmp/proj", prompt: "install deps", permissionMode: "default" });
    const seen: AgentEvent[] = [];
    for await (const e of s.events()) {
      seen.push(e);
      if (e.kind === "needs-permission") {
        expect(e.tool).toBe("Bash");
        expect(e.detail).toBe("npm install");
        s.respondPermission(e.requestId, "allow");
      }
      if (e.kind === "done") break;
    }
    expect(capture.options!.settingSources).toEqual(["user", "project", "local"]);
    expect(capture.options!.cwd).toBe("/tmp/proj");
    expect(capture.options!.permissionMode).toBe("default");
    expect(seen.map((e) => e.kind)).toEqual([
      "started", "needs-permission", "text-delta", "tool-use", "usage-metadata", "usage-metadata", "done",
    ]);
    expect(s.handoffCommand()).toBe("claude --resume sess-123");
    const done = seen.at(-1) as { kind: "done"; summary?: string };
    expect(done.summary).toBe("All set.");
  });

  it("deny path completes without the assistant turn", async () => {
    const a = new ClaudeAdapter({ queryFn: scriptedQueryFn({}) });
    const s = a.spawn({ cwd: "/tmp", prompt: "install", permissionMode: "default" });
    const seen: AgentEvent[] = [];
    for await (const e of s.events()) {
      seen.push(e);
      if (e.kind === "needs-permission") s.respondPermission(e.requestId, "deny");
      if (e.kind === "done" || e.kind === "error") break;
    }
    expect(seen.some((e) => e.kind === "text-delta")).toBe(false);
    expect(seen.at(-1)!.kind).toBe("done");
  });
});
