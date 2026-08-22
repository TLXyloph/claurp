import { describe, expect, it } from "vitest";
import { daemonToSenses, sensesToDaemon, frames } from "../scripts/golden-samples.js";
import { parseDaemonMsg, parseSensesMsg } from "../src/index.js";

type Sample = { file: string; msg: unknown };
const byType = (samples: Sample[], type: string) =>
  samples.filter((s) => (s.msg as { type: string }).type === type);
const field = (samples: Sample[], type: string, key: string) =>
  new Set(byType(samples, type).map((s) => (s.msg as Record<string, unknown>)[key]));

describe("golden samples", () => {
  it("every daemon→senses sample passes the zod schema", () => {
    for (const s of daemonToSenses) expect(() => parseDaemonMsg(s.msg)).not.toThrow();
  });

  it("every senses→daemon sample passes the zod schema", () => {
    for (const s of sensesToDaemon) expect(() => parseSensesMsg(s.msg)).not.toThrow();
  });

  it("filenames are unique per directory", () => {
    for (const list of [daemonToSenses, sensesToDaemon, frames]) {
      expect(new Set(list.map((s) => s.file)).size).toBe(list.length);
    }
  });

  it("covers every enum variant", () => {
    expect(field(daemonToSenses, "state", "mode")).toEqual(
      new Set(["idle", "listening", "working", "needs-you", "disconnected"]));
    expect(field(daemonToSenses, "earcon", "kind")).toEqual(
      new Set(["wake-ack", "shutter", "permission-ask", "done"]));
    expect(field(daemonToSenses, "hud.session", "state")).toEqual(
      new Set(["spawning", "working", "needs-permission", "needs-input", "done", "failed", "handed-off"]));
    expect(field(daemonToSenses, "hud.session", "permissionMode")).toEqual(
      new Set(["default", "acceptEdits", "plan", "bypassPermissions"]));
    expect(field(sensesToDaemon, "ptt", "action")).toEqual(new Set(["down", "up"]));
    expect(field(sensesToDaemon, "permission.response", "decision")).toEqual(
      new Set(["allow", "deny", "always"]));
    const notifyActions = new Set(
      byType(daemonToSenses, "notify").flatMap((s) => ((s.msg as { actions?: string[] }).actions ?? [])));
    expect(notifyActions).toEqual(new Set(["allow", "deny", "open-terminal"]));
  });
});
