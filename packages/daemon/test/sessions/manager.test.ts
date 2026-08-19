import { describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../../src/agents/fake.js";
import { SessionManager } from "../../src/sessions/manager.js";

const project = { name: "tmp", cwd: "/tmp" };
function makeManager() {
  return new SessionManager(new Map([["fake", new FakeAgent()]]), { defaultAdapter: "fake" });
}

describe("SessionManager", () => {
  it("labels sessions from the prompt", () => {
    const m = makeManager();
    const r = m.spawn({ prompt: "please refactor the auth flow for me", project });
    expect(r.label).toBe("refactor auth flow me");
    expect(m.focused()!.id).toBe(r.id);
  });

  it("tracks lifecycle through events and pending permission", () => {
    const m = makeManager();
    const r = m.spawn({ prompt: "make notes", project });
    m.consume(r.id, { kind: "started", backendSessionId: null });
    expect(m.roster()[0].state).toBe("working");
    m.consume(r.id, { kind: "needs-permission", requestId: "r1", tool: "Write", detail: "write notes.txt" });
    expect(m.roster()[0].state).toBe("needs-permission");
    expect(m.roster()[0].pendingPermission?.requestId).toBe("r1");
    m.respondPermission(r.id, "allow");
    expect(m.roster()[0].state).toBe("working");
    expect(m.roster()[0].pendingPermission).toBeNull();
  });

  it("switchTo matches labels case-insensitively and refocuses", () => {
    const m = makeManager();
    m.spawn({ prompt: "refactor the auth flow", project });
    const b = m.spawn({ prompt: "write release notes", project });
    expect(m.focused()!.id).toBe(b.id);
    const hit = m.switchTo("the AUTH one");
    expect(hit?.label).toContain("auth");
    expect(m.focused()!.label).toContain("auth");
    expect(m.switchTo("nonexistent zebra")).toBeNull();
  });

  it("handoff marks the session and returns the command (null for fake)", () => {
    const m = makeManager();
    const r = m.spawn({ prompt: "make notes", project });
    expect(m.handoff(r.id)).toBeNull();               // FakeAgent has no resume
    expect(m.roster()[0].state).toBe("handed-off");
  });

  it("notifies onChange subscribers", () => {
    const m = makeManager();
    const cb = vi.fn();
    m.onChange(cb);
    const r = m.spawn({ prompt: "x", project });
    m.consume(r.id, { kind: "done" });
    expect(cb).toHaveBeenCalled();
    expect(m.roster()[0].state).toBe("done");
    void r;
  });
});
