import { describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../../src/agents/fake.js";
import { SessionManager } from "../../src/sessions/manager.js";

// manager.test.ts is frozen; these are the fix-loop edge cases for the two Important findings:
// (1) respondPermission must not resurrect state when there is no pending ask (or the session
//     is already terminal), and (2) kill() must force a terminal state that consume() then
//     refuses to move off of.
const project = { name: "tmp", cwd: "/tmp" };
function makeManager() {
  return new SessionManager(new Map([["fake", new FakeAgent()]]), { defaultAdapter: "fake" });
}

describe("SessionManager edge cases", () => {
  it("(a) respondPermission with no pending ask is a complete no-op", () => {
    const m = makeManager();
    const r = m.spawn({ prompt: "make notes", project });
    const stateBefore = m.roster()[0].state;
    const cb = vi.fn();
    m.onChange(cb);

    m.respondPermission(r.id, "allow");

    expect(m.roster()[0].state).toBe(stateBefore);
    expect(m.roster()[0].pendingPermission).toBeNull();
    expect(cb).not.toHaveBeenCalled();
  });

  it("(b) respondPermission after 'done' does not resurrect the session, even with a stale pending ask", () => {
    const m = makeManager();
    const r = m.spawn({ prompt: "make notes", project });
    m.consume(r.id, { kind: "needs-permission", requestId: "r1", tool: "Write", detail: "write notes.txt" });
    expect(m.roster()[0].pendingPermission).not.toBeNull();
    // Simulate the adapter ending abruptly (e.g. process exit) without an explicit
    // respondPermission call, leaving a stale pendingPermission behind.
    m.consume(r.id, { kind: "done" });
    expect(m.roster()[0].state).toBe("done");

    m.respondPermission(r.id, "allow");

    expect(m.roster()[0].state).toBe("done");
  });

  it("(c) kill() sets state to 'done', clears pending, and fires onChange", () => {
    const m = makeManager();
    const r = m.spawn({ prompt: "make notes", project });
    m.consume(r.id, { kind: "needs-permission", requestId: "r1", tool: "Write", detail: "write notes.txt" });
    expect(m.roster()[0].pendingPermission).not.toBeNull();

    const cb = vi.fn();
    m.onChange(cb);
    m.kill(r.id);

    expect(m.roster()[0].state).toBe("done");
    expect(m.roster()[0].pendingPermission).toBeNull();
    expect(cb).toHaveBeenCalled();
  });

  it("(d) consume() after kill() is ignored; state stays 'done'", () => {
    const m = makeManager();
    const r = m.spawn({ prompt: "make notes", project });
    m.kill(r.id);
    expect(m.roster()[0].state).toBe("done");

    m.consume(r.id, { kind: "error", message: "late failure after kill" });

    expect(m.roster()[0].state).toBe("done");
  });
});
