// policy.test.ts is frozen; this file encodes the adversarial hardening pass -- every
// must-BLOCK and must-ALLOW case named in the security review's two rounds of findings
// (findings 1-6, then the supplemental findings 7-10), plus proofs that the deny-list still
// cannot be bypassed by a stored always-allow grant after the hardening.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { classify, hardDeny, PermissionPolicy } from "../src/policy.js";

beforeEach(() => {
  process.env.CLAURP_HOME = mkdtempSync(join(tmpdir(), "claurp-pol-adv-"));
});

describe("finding 1: rm recursive+force -- GNU long-form, split flags, case", () => {
  const blocked: Array<[string, string]> = [
    ["Bash", "rm --recursive --force x"],
    ["Bash", "rm -R -f x"],
    ["Bash", "rm -Rf x"],
    ["Bash", "RM -RF x"],
    ["Bash", "rm --force --recursive x"],
    ["Bash", "rm -r -f"], // finding 8: keep denying this one explicitly
  ];
  const allowed: Array<[string, string]> = [
    ["Bash", "rm build/out.txt"],
    ["Bash", "rm file.txt"],
  ];
  it.each(blocked)("denies %s %s", (t, d) => expect(hardDeny(t, d)).toBe(true));
  it.each(allowed)("permits %s %s", (t, d) => expect(hardDeny(t, d)).toBe(false));
});

describe("finding 8: rm force-only (no recursive) is NOT a hard deny", () => {
  const allowed: Array<[string, string]> = [
    ["Bash", "rm -f file.txt"],
    ["Bash", "docker rm -f container"],
    ["Bash", "rm -f build/out.o"],
  ];
  it.each(allowed)("permits %s %s", (t, d) => expect(hardDeny(t, d)).toBe(false));
});

describe("finding 2: git global options between `git` and the subcommand", () => {
  const blocked: Array<[string, string]> = [
    ["Bash", "git -C /repo push --force"],
    ["Bash", "git --no-pager push --force"],
    ["Bash", "git -c user.name=x reset --hard HEAD~1"],
    ["Bash", "git -C . clean -fd"],
    ["Bash", "git -c x=y checkout -- ."],
  ];
  const allowed: Array<[string, string]> = [
    ["Bash", "git push origin feature"],
    ["Bash", "git checkout feature-branch"],
    ["Bash", "git status"],
  ];
  it.each(blocked)("denies %s %s", (t, d) => expect(hardDeny(t, d)).toBe(true));
  it.each(allowed)("permits %s %s", (t, d) => expect(hardDeny(t, d)).toBe(false));
});

describe("finding 3: git checkout --force / -f (force-discard)", () => {
  const blocked: Array<[string, string]> = [
    ["Bash", "git checkout --force"],
    ["Bash", "git checkout -f"],
  ];
  const allowed: Array<[string, string]> = [
    ["Bash", "git checkout feature-branch"],
    ["Bash", "git checkout -b new-branch"],
  ];
  it.each(blocked)("denies %s %s", (t, d) => expect(hardDeny(t, d)).toBe(true));
  it.each(allowed)("permits %s %s", (t, d) => expect(hardDeny(t, d)).toBe(false));
});

describe("finding 4: secret-path lookahead -- quote/colon/comma/paren terminators fire", () => {
  const blocked: Array<[string, string]> = [
    ["Bash", "cat 'credentials'"],
    ["Bash", "echo credentials:"],
    ["Bash", "cat (credentials)"],
    ["Read", "config/secrets.yml"],
    ["Read", ".env.local"],
    ["Read", "~/.aws/credentials"],
  ];
  const allowed: Array<[string, string]> = [
    ["Read", "docs/secrets-policy.md"],
    ["Read", "src/environment.ts"],
  ];
  it.each(blocked)("denies %s %s", (t, d) => expect(hardDeny(t, d)).toBe(true));
  it.each(allowed)("permits %s %s", (t, d) => expect(hardDeny(t, d)).toBe(false));
});

describe("finding 5: secret-read scope extends to any content-surfacing tool", () => {
  it("denies Grep of a secret path", () => {
    expect(hardDeny("Grep", "password .env")).toBe(true);
  });
  it("denies Glob of a secret path", () => {
    expect(hardDeny("Glob", "**/id_rsa")).toBe(true);
  });
  it("denies NotebookRead of a secret path", () => {
    expect(hardDeny("NotebookRead", "secrets.ipynb")).toBe(true);
  });
  it("does NOT extend the delete/git rules to non-Bash tools", () => {
    // Same text as a denied rm/git case, but on a tool that can't execute shell commands --
    // the rm/git rules stay Bash-only.
    expect(hardDeny("Read", "rm -rf ./build")).toBe(false);
    expect(hardDeny("Grep", "git push --force")).toBe(false);
  });
});

describe("finding 6: Bash network classification is case-insensitive", () => {
  it("classifies 'CURL https://x' as network, not exec", () => {
    expect(classify("Bash", "CURL https://x")).toBe("network");
  });
});

describe("finding 7: .*-based bridges don't stop at a line continuation", () => {
  it("denies a force-push whose --force is on a continuation line", () => {
    expect(hardDeny("Bash", "git push origin main \\\n  --force")).toBe(true);
  });
  it("denies a git clean whose --force is on a continuation line", () => {
    expect(hardDeny("Bash", "git clean -d \\\n--force")).toBe(true);
  });
  it("still permits a benign multi-line command with no dangerous flag", () => {
    expect(hardDeny("Bash", "npm install \\\n  --save-dev typescript")).toBe(false);
  });
});

describe("finding 9: spec §5.4 equivalents", () => {
  const blocked: Array<[string, string]> = [
    ["Bash", "git branch -D old-feature"],
    ["Bash", "git filter-repo"],
    ["Bash", "git restore ."],
    ["Bash", "git restore --staged --worktree ."],
    ["Bash", "git reflog expire --expire=now --all"],
    ["Bash", "git update-ref -d refs/heads/stale"],
    ["Bash", "find . -delete"],
    ["Bash", "find . -exec rm {} \\;"],
    ["Bash", "git push origin +main"],
  ];
  const allowed: Array<[string, string]> = [
    ["Bash", "git branch feature"],
    ["Bash", "git restore --help"],
    ["Bash", "find . -name '*.ts'"],
    ["Bash", "git push origin main"],
  ];
  it.each(blocked)("denies %s %s", (t, d) => expect(hardDeny(t, d)).toBe(true));
  it.each(allowed)("permits %s %s", (t, d) => expect(hardDeny(t, d)).toBe(false));
});

describe("finding 10: hyphen-continuation false positives on verb/flag boundaries", () => {
  const blocked: Array<[string, string]> = [
    ["Bash", "git rebase main"],
    ["Bash", "git rebase -i HEAD~3"],
  ];
  const allowed: Array<[string, string]> = [
    ["Bash", "git rebase-todo-checker"],
    ["Bash", "git push origin hotfix-f"],
  ];
  it.each(blocked)("denies %s %s", (t, d) => expect(hardDeny(t, d)).toBe(true));
  it.each(allowed)("permits %s %s", (t, d) => expect(hardDeny(t, d)).toBe(false));
});

describe("post-hardening: the deny-list still cannot be bypassed by policy", () => {
  it("recordAlways still refuses a hard-deny match (GNU long-form rm)", () => {
    const p = new PermissionPolicy();
    expect(p.recordAlways("Bash", "rm --recursive --force x")).toBe(false);
    expect(p.decide("Bash", "rm --recursive --force x")).toEqual({
      action: "ask",
      alwaysable: false,
    });
  });

  it("a Grep of a secret path is not auto-allowed even with an existing Bash/exec always-allow grant", () => {
    const p = new PermissionPolicy();
    expect(p.recordAlways("Bash", "npm test")).toBe(true); // grants Bash/exec
    expect(p.decide("Bash", "npm run lint")).toEqual({ action: "auto-allow" }); // grant applies
    expect(p.decide("Grep", "password .env")).toEqual({ action: "ask", alwaysable: false }); // hardDeny still wins
  });
});
