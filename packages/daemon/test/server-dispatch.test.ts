// Dispatch-level unit test (review fix round, Minor): a session that's been handed off to a
// terminal (spec §5.3) is voice-immutable exactly like a done/failed one -- `mode`/`handoff`
// voice commands on a handed-off focused session must be no-ops with an honest refusal, not
// silently call handle.setPermissionMode()/handoff() again on a session the terminal now owns.
// Drives dispatchIntent() directly against a real SessionManager+FakeAgent (no WS/server layer
// needed -- this is pure intent-dispatch logic, see server-dispatch.ts's own header comment).
import { describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../src/agents/fake.js";
import { MeterService } from "../src/meter.js";
import { Narrator } from "../src/narrator.js";
import { PermissionPolicy } from "../src/policy.js";
import { dispatchIntent, type DispatchContext } from "../src/server-dispatch.js";
import { SessionManager } from "../src/sessions/manager.js";
import type { Project } from "../src/sessions/projects.js";

const project: Project = { name: "demo", cwd: process.cwd() };

function makeManager(): SessionManager {
  return new SessionManager(new Map([["fake", new FakeAgent()]]), { defaultAdapter: "fake" });
}

function makeContext(manager: SessionManager): {
  ctx: DispatchContext;
  speak: ReturnType<typeof vi.fn>;
  runHandoffTerminal: ReturnType<typeof vi.fn>;
} {
  const speak = vi.fn();
  const runHandoffTerminal = vi.fn();
  const ctx: DispatchContext = {
    manager,
    projects: { defaultProject: project, byName: new Map([["demo", project]]) },
    policy: new PermissionPolicy(),
    meter: new MeterService(),
    narrator: new Narrator(),
    speak,
    spawn: vi.fn((prompt: string, p: Project) => manager.spawn({ prompt, project: p })),
    runHandoffTerminal,
  };
  return { ctx, speak, runHandoffTerminal };
}

describe("dispatchIntent: handed-off sessions are voice-immutable (review fix round)", () => {
  it("mode intent on a handed-off focused session is a no-op with an honest refusal", () => {
    const manager = makeManager();
    const record = manager.spawn({ prompt: "make notes", project });
    manager.handoff(record.id);
    expect(manager.roster()[0].state).toBe("handed-off");
    const modeBefore = manager.roster()[0].permissionMode;

    const { ctx, speak } = makeContext(manager);
    dispatchIntent({ kind: "mode", mode: "plan", confirmed: true }, ctx);

    expect(speak).toHaveBeenCalledWith(`${record.label} is in your terminal now.`);
    expect(manager.roster()[0].permissionMode).toBe(modeBefore); // setPermissionMode() never called
    expect(manager.roster()[0].state).toBe("handed-off"); // not re-mutated
  });

  it("session/handoff intent on an already handed-off focused session is a no-op with an honest refusal", () => {
    const manager = makeManager();
    const record = manager.spawn({ prompt: "make notes", project });
    manager.handoff(record.id);
    expect(manager.roster()[0].state).toBe("handed-off");

    const { ctx, speak, runHandoffTerminal } = makeContext(manager);
    dispatchIntent({ kind: "session", op: "handoff" }, ctx);

    expect(speak).toHaveBeenCalledWith(`${record.label} is in your terminal now.`);
    expect(runHandoffTerminal).not.toHaveBeenCalled();
  });

  it("still refuses done/failed sessions with the pre-existing 'already finished' copy (unchanged behavior)", () => {
    const manager = makeManager();
    const record = manager.spawn({ prompt: "make notes", project });
    manager.kill(record.id); // kill() lands on state "done" (manager.ts)
    expect(manager.roster()[0].state).toBe("done");

    const { ctx, speak } = makeContext(manager);
    dispatchIntent({ kind: "mode", mode: "plan", confirmed: true }, ctx);
    expect(speak).toHaveBeenCalledWith(`${record.label} already finished.`);

    speak.mockClear();
    dispatchIntent({ kind: "session", op: "handoff" }, ctx);
    expect(speak).toHaveBeenCalledWith(`${record.label} already finished.`);
  });

  it("a working (non-terminal) focused session is still voice-mutable", () => {
    const manager = makeManager();
    const record = manager.spawn({ prompt: "make notes", project });
    expect(manager.roster()[0].state).not.toBe("handed-off");

    const { ctx, speak } = makeContext(manager);
    dispatchIntent({ kind: "mode", mode: "plan", confirmed: true }, ctx);

    expect(manager.roster()[0].permissionMode).toBe("plan"); // setPermissionMode() DID run
    expect(speak).toHaveBeenCalledWith(`${record.label} is now in plan mode.`);
  });
});
