// policy.test.ts is frozen; these cover the persistence-tolerance requirements from the task
// brief that the frozen table-driven tests don't exercise directly: a missing policy.json is
// fine, a corrupt one is tolerated (never crashes -- treated as empty, warns at most once), and
// the on-disk shape written by recordAlways() is the one PermissionPolicy itself can reload.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionPolicy } from "../src/policy.js";

let claurpHomeDir: string;

beforeEach(() => {
  claurpHomeDir = mkdtempSync(join(tmpdir(), "claurp-pol-persist-"));
  process.env.CLAURP_HOME = claurpHomeDir;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function policyPath(): string {
  return join(claurpHomeDir, "policy.json");
}

describe("PermissionPolicy persistence tolerance", () => {
  it("does not crash and behaves as empty when policy.json is missing", () => {
    expect(existsSync(policyPath())).toBe(false);
    const p = new PermissionPolicy();
    expect(p.decide("Bash", "npm test")).toEqual({ action: "ask", alwaysable: true });
  });

  it("does not crash and behaves as empty when policy.json is corrupt JSON, and warns once", () => {
    mkdirSync(claurpHomeDir, { recursive: true });
    writeFileSync(policyPath(), "{ not valid json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const p1 = new PermissionPolicy();
    const p2 = new PermissionPolicy();

    expect(p1.decide("Bash", "npm test")).toEqual({ action: "ask", alwaysable: true });
    expect(p2.decide("Bash", "npm test")).toEqual({ action: "ask", alwaysable: true });
    // Warn is a module-level once-per-process guard, not once-per-instance -- constructing two
    // policies against the same corrupt file still only logs a single warning.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not crash and behaves as empty when policy.json is valid JSON but the wrong shape", () => {
    mkdirSync(claurpHomeDir, { recursive: true });
    writeFileSync(policyPath(), JSON.stringify({ alwaysAllow: [{ tool: "Bash" }] })); // missing "class"
    const p = new PermissionPolicy();
    expect(p.decide("Bash", "npm test")).toEqual({ action: "ask", alwaysable: true });
  });

  it("writes a reloadable {alwaysAllow: [{tool, class}]} shape", () => {
    const p1 = new PermissionPolicy();
    p1.recordAlways("Bash", "npm test");

    const onDisk: unknown = JSON.parse(readFileSync(policyPath(), "utf8"));
    expect(onDisk).toEqual({ alwaysAllow: [{ tool: "Bash", class: "exec" }] });

    const p2 = new PermissionPolicy();
    expect(p2.decide("Bash", "npm test")).toEqual({ action: "auto-allow" });
  });
});
