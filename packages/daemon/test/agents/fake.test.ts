import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@claurp/protocol";
import { FakeAgent } from "../../src/agents/fake.js";
import { adapterContractSuite } from "../../src/agents/contract.js";

async function collect(events: AsyncIterable<AgentEvent>, until: AgentEvent["kind"] = "done") {
  const out: AgentEvent[] = [];
  for await (const e of events) { out.push(e); if (e.kind === until || e.kind === "error") break; }
  return out;
}

adapterContractSuite("fake", () => new FakeAgent());

describe("FakeAgent specifics", () => {
  it("allow path reaches done with prior text", async () => {
    const s = new FakeAgent().spawn({ cwd: "/tmp", prompt: "make notes", permissionMode: "default" });
    const seen: AgentEvent[] = [];
    for await (const e of s.events()) {
      seen.push(e);
      if (e.kind === "needs-permission") s.respondPermission(e.requestId, "allow");
      if (e.kind === "done") break;
    }
    expect(seen.map((e) => e.kind)).toEqual([
      "started", "tool-use", "needs-permission", "text-delta", "usage-metadata", "done",
    ]);
  });

  it("acceptEdits mode skips the permission ask", async () => {
    const s = new FakeAgent().spawn({ cwd: "/tmp", prompt: "make notes", permissionMode: "acceptEdits" });
    const seen = await collect(s.events());
    expect(seen.some((e) => e.kind === "needs-permission")).toBe(false);
    expect(seen.at(-1)!.kind).toBe("done");
  });
});
