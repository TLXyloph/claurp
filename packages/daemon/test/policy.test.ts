import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { classify, hardDeny, PermissionPolicy } from "../src/policy.js";

beforeEach(() => { process.env.CLAURP_HOME = mkdtempSync(join(tmpdir(), "claurp-pol-")); });

describe("classify", () => {
  const cases: Array<[string, string, string]> = [
    ["Read", "src/app.ts", "read"],
    ["Grep", "TODO", "read"],
    ["Edit", "src/app.ts", "write"],
    ["Write", "notes.txt", "write"],
    ["Bash", "npm test", "exec"],
    ["Bash", "curl https://example.com", "network"],
    ["WebFetch", "https://example.com", "network"],
    ["MysteryTool", "whatever", "exec"],
  ];
  it.each(cases)("%s %s → %s", (tool, detail, cls) => expect(classify(tool, detail)).toBe(cls));
});

describe("hardDeny", () => {
  const denied: Array<[string, string]> = [
    ["Bash", "rm -rf ./build"],
    ["Bash", "rm -fr /tmp/x"],
    ["Bash", "git push --force origin main"],
    ["Bash", "git push -f"],
    ["Bash", "git reset --hard HEAD~3"],
    ["Bash", "git rebase -i main"],
    ["Bash", "git checkout -- ."],
    ["Bash", "git clean -fd"],
    ["Bash", "cat .env"],
    ["Read", "/Users/x/.env.production"],
    ["Read", "~/.ssh/id_rsa"],
    ["Read", "deploy/server.pem"],
  ];
  const allowed: Array<[string, string]> = [
    ["Bash", "rm build/out.txt"],
    ["Bash", "git push origin feature"],
    ["Bash", "git checkout feature-branch"],
    ["Read", "src/environment.ts"],
    ["Read", "docs/secrets-policy.md"],   // word boundary: mentions secrets in a doc *name* — tune regex if this fails
  ];
  it.each(denied)("denies %s %s", (t, d) => expect(hardDeny(t, d)).toBe(true));
  it.each(allowed)("permits %s %s", (t, d) => expect(hardDeny(t, d)).toBe(false));
});

describe("PermissionPolicy", () => {
  it("auto-allows reads, asks for writes, refuses always on hard-deny", () => {
    const p = new PermissionPolicy();
    expect(p.decide("Read", "src/app.ts")).toEqual({ action: "auto-allow" });
    expect(p.decide("Write", "notes.txt")).toEqual({ action: "ask", alwaysable: true });
    expect(p.decide("Bash", "git push --force")).toEqual({ action: "ask", alwaysable: false });
    expect(p.recordAlways("Bash", "git push --force")).toBe(false);
  });

  it("persists always-allow across instances by class+tool", () => {
    const p1 = new PermissionPolicy();
    expect(p1.recordAlways("Bash", "npm test")).toBe(true);
    const p2 = new PermissionPolicy();
    expect(p2.decide("Bash", "npm run lint")).toEqual({ action: "auto-allow" }); // same tool+class
    expect(p2.decide("Bash", "curl https://x.dev")).toEqual({ action: "ask", alwaysable: true }); // network class still asks
  });
});
