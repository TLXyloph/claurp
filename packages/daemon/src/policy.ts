// Permission policy engine (spec §5.4): classifies tool calls into risk classes, and enforces a
// hard deny-list that is never auto-allowed and never "always"-able -- decide() and
// recordAlways() both consult hardDeny() before consulting anything else (persisted
// always-allow entries included), so the deny-list cannot be bypassed by policy or by a stored
// "always allow" decision. Persists user-granted always-allow decisions to
// ~/.claurp/policy.json (CLAURP_HOME-relative, see paths.ts), at tool+class granularity.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { claurpHome } from "./paths.js";

export type RiskClass = "read" | "write" | "exec" | "network";

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
// "i" -- a Bash command's casing (e.g. `CURL https://x`) doesn't change what it does.
const BASH_NETWORK_RE = /\b(curl|wget|https?:\/\/)/i;

export function classify(tool: string, detail: string): RiskClass {
  if (READ_TOOLS.has(tool)) return "read";
  if (WRITE_TOOLS.has(tool)) return "write";
  if (NETWORK_TOOLS.has(tool)) return "network";
  if (tool === "Bash") return BASH_NETWORK_RE.test(detail) ? "network" : "exec";
  return "exec"; // unknown tools: conservative
}

// ---------------------------------------------------------------------------------------------
// spec §5.4 hard deny-list.
//
// This list is defense-in-depth, not the primary gate: the permission-ASK path (decide()'s
// "ask" verdicts) is what actually stops an agent from running an arbitrary command -- hardDeny
// only removes the "always allow" escape hatch for the highest-impact destructive operations
// and their most common equivalents. It is deliberately not exhaustive coverage of every way to
// delete/rewrite/discard something in a shell.
// ---------------------------------------------------------------------------------------------

// rm recursive delete: GNU short (bundled or separate, any case) and long-form flags. Denies on
// recursive-intent ALONE (-r/-R/--recursive) -- spec §5.4 targets "recursive/forced deletes",
// and a bare recursive delete (e.g. "rm -r ./build", no -f) is already the dangerous operation
// (it still prompts for confirmation per-file without -f, but it can still tear through a whole
// directory tree). Force is not part of the deny condition at all: force-only (e.g. "rm -f
// file.txt", "docker rm -f container") is a single-file delete, not a recursive one, so it
// stays ask-able rather than hard-denied.
//
// Implemented as a token scan, not a single "search anywhere" regex: an unanchored pattern
// can't tell an actual "-r"/"-rf" flag token apart from an "-r"/"-rf" substring buried inside an
// unrelated filename (e.g. "out-report.txt"), so each whitespace-delimited token is matched
// against a flag pattern anchored to the *whole* token. Splitting on `/\s+/` is newline-safe
// too (whitespace includes "\n"), so a line-continued command can't dodge this by breaking the
// flag onto its own line.
const RM_WORD_RE = /\brm\b/i;
const SHORT_FLAG_RE = /^-[a-zA-Z]+$/; // e.g. -r, -f, -rf, -Rf, -fr, -i (letters only after the dash)
const LONG_RECURSIVE_RE = /^--recursive$/i;

function isRmRecursiveDelete(detail: string): boolean {
  if (!RM_WORD_RE.test(detail)) return false;
  for (const token of detail.split(/\s+/)) {
    if (LONG_RECURSIVE_RE.test(token)) return true;
    if (SHORT_FLAG_RE.test(token) && /r/i.test(token)) return true;
  }
  return false;
}

// git accepts global options *between* `git` and the subcommand (e.g. `git -C /repo push
// --force`, `git -c user.name=x reset --hard`). Every git rule below is prefixed with this so a
// global-option prefix can't smuggle a dangerous subcommand past a rule anchored to a bare
// "git <subcommand>". `-C`/`-c` are deliberately kept case-sensitive here -- git itself treats
// them as two different flags (`-C` = change directory, `-c` = set a config value).
const GIT_GLOBAL_OPT_SRC = String.raw`(?:-C\s+\S+|-c\s+\S+|--no-pager|--git-dir(?:=|\s+)\S+)`;
const GIT_PREFIX_SRC = String.raw`\bgit\b(?:\s+${GIT_GLOBAL_OPT_SRC})*\s+`;

// Flag-detection patterns that "bridge" from the subcommand to a flag appearing later in the
// string use `[\s\S]*` rather than `.*` -- `.` does not cross a newline without the `s` flag,
// and Bash commands legitimately span multiple lines (shell line continuations), so a plain
// `.*` bridge is trivially evaded by putting the dangerous flag on its own line. Every such
// bridge below also requires the flag to be preceded by whitespace and followed by
// `(?![\w-])` (not `\b`) -- `\b` alone fires on a word-char -> hyphen transition too, which
// would false-positive on a branch/file name that merely *ends* in the flag's letters (e.g.
// "-f" hiding inside "hotfix-f", or "-D" inside "feature-Design").
const GIT_PUSH_FORCE_RE = new RegExp(
  GIT_PREFIX_SRC + String.raw`push\b[\s\S]*\s(?:--force|-f)(?![\w-])`,
);
// Refspec force-push: a leading "+" on the refspec (e.g. `git push origin +main`) forces the
// push without needing --force/-f at all.
const GIT_PUSH_REFSPEC_FORCE_RE = new RegExp(GIT_PREFIX_SRC + String.raw`push\b[\s\S]*\s\+\S`);
// History rewrites. "filter-repo" is filter-branch's modern replacement (spec §5.4
// "equivalents"). The single trailing `(?![\w-])` (after the whole alternation, not `\b`)
// stops e.g. "git rebase-todo-checker" or "git reset --hardcore" (not real git, but the same
// false-positive shape) from matching a verb that's merely a *prefix* of what was typed.
const GIT_HISTORY_REWRITE_RE = new RegExp(
  GIT_PREFIX_SRC + String.raw`(?:reset\s+--hard|rebase|filter-branch|filter-repo)(?![\w-])`,
);
const GIT_CLEAN_F_RE = new RegExp(GIT_PREFIX_SRC + String.raw`clean\b[\s\S]*-[a-z]*f`);
// Discarding changes: `checkout -- <path>`, and `checkout --force`/`checkout -f` (same discard,
// no pathspec needed). No bridging here (the flag must be the token immediately after
// "checkout") so `git checkout -b new-branch` / `git checkout feature-branch` are unaffected.
const GIT_CHECKOUT_DISCARD_RE = new RegExp(
  GIT_PREFIX_SRC + String.raw`checkout\s+(?:--\s|--force\b|-f\b)`,
);
// Force-deleting a branch.
const GIT_BRANCH_FORCE_DELETE_RE = new RegExp(
  GIT_PREFIX_SRC + String.raw`branch\b[\s\S]*\s-D(?![\w-])`,
);
// `restore` with any real argument (a pathspec, or flags like --staged/--worktree) discards
// working-tree/index changes the same way `checkout --` does; `git restore --help` must not
// trip this.
const GIT_RESTORE_DISCARD_RE = new RegExp(
  GIT_PREFIX_SRC + String.raw`restore\b(?!\s*(?:--help|-h)\b)\s+\S`,
);
const GIT_REFLOG_EXPIRE_RE = new RegExp(GIT_PREFIX_SRC + String.raw`reflog\s+expire\b`);
const GIT_UPDATE_REF_DELETE_RE = new RegExp(
  GIT_PREFIX_SRC + String.raw`update-ref\b[\s\S]*\s-d(?![\w-])`,
);

// `find`-based deletes: a recursive-delete escape hatch around `rm` itself (spec §5.4 "and
// their equivalents"). Bash-only, like every rule above.
const FIND_DELETE_RE = /\bfind\b[\s\S]*\s-delete(?![\w-])/;
const FIND_EXEC_RM_RE = /\bfind\b[\s\S]*\s-exec\s+rm(?![\w-])/;

const BASH_DENY_PATTERNS: RegExp[] = [
  GIT_CLEAN_F_RE,
  GIT_PUSH_FORCE_RE,
  GIT_PUSH_REFSPEC_FORCE_RE,
  GIT_HISTORY_REWRITE_RE,
  GIT_CHECKOUT_DISCARD_RE,
  GIT_BRANCH_FORCE_DELETE_RE,
  GIT_RESTORE_DISCARD_RE,
  GIT_REFLOG_EXPIRE_RE,
  GIT_UPDATE_REF_DELETE_RE,
  FIND_DELETE_RE,
  FIND_EXEC_RM_RE,
];

// Secret-path token, checked for every tool that can surface file *contents* (Read, Bash, Grep,
// Glob, NotebookRead -- not Write/Edit, which don't read anything back to the caller).
// Boundary-anchored on both sides via lookaround (not consumed, so nothing needs to be captured
// or re-matched) so it only matches an isolated path-ish token, never a substring fused to a
// larger identifier:
//  - start: `(?<![\w-])` -- not immediately preceded by a word char or hyphen. This is
//    deliberately broader than "whitespace or /": a shell-quoted or punctuated argument like
//    `cat 'credentials'`, `echo credentials:`, or `cat (credentials)` has a quote/colon/paren
//    immediately before the word, not whitespace or a slash, and must still match.
//  - end (bare "credentials"/"secrets" words only): `(?![\w-])` -- not immediately followed by
//    a word char or hyphen. A plain word-boundary `\b` would *also* fire on a hyphen (it's a
//    non-word char too), so "secrets\b" matches inside "secrets-policy" -- the false positive
//    on the doc filename "docs/secrets-policy.md" (mentions "secrets" in a hyphenated compound,
//    isn't a secrets path). Excluding hyphen specifically (while still allowing quote / colon /
//    comma / paren / slash / dot / whitespace / end-of-string as valid terminators) keeps that
//    doc name out while still matching "secrets/api_key", "credentials.json",
//    "echo credentials:", etc.
//  - the extension-based alternatives (.env, .pem, .key, id_rsa/id_ed25519) are already
//    self-bounded by their literal suffix, so they don't need the end lookahead too.
const SECRET_PATH_RE =
  /(?<![\w-])(?:\.env(?:\.[\w-]+)?|id_(?:rsa|ed25519)|[\w-]+\.pem|[\w-]+\.key|credentials?(?![\w-])|secrets?(?![\w-]))/i;
const SECRET_SCAN_TOOLS = new Set(["Read", "Bash", "Grep", "Glob", "NotebookRead"]);

export function hardDeny(tool: string, detail: string): boolean {
  if (tool === "Bash") {
    if (isRmRecursiveDelete(detail)) return true;
    if (BASH_DENY_PATTERNS.some((re) => re.test(detail))) return true;
  }
  if (SECRET_SCAN_TOOLS.has(tool) && SECRET_PATH_RE.test(detail)) return true;
  return false;
}

export type Verdict =
  | { action: "auto-allow" }
  | { action: "ask"; alwaysable: true }
  | { action: "ask"; alwaysable: false };

interface AlwaysAllowEntry {
  tool: string;
  class: RiskClass;
}

// ~/.claurp/policy.json shape: a flat list of (tool, class) pairs the user has granted
// "always allow" for. Keyed by tool+class (not by exact detail/command) -- matches the
// PermissionPolicy test's "same tool+class" expectation (recording "Bash npm test" also
// auto-allows "Bash npm run lint", since both classify to Bash/exec).
const PolicyFileSchema = z.object({
  alwaysAllow: z.array(
    z.object({ tool: z.string(), class: z.enum(["read", "write", "exec", "network"]) }),
  ),
});

// Warn at most once per process about an unreadable/corrupt policy file, rather than on every
// PermissionPolicy construction -- avoids log spam when several instances are created (as the
// persistence test does) while still surfacing the problem once.
let warnedCorrupt = false;

function policyPath(): string {
  return join(claurpHome(), "policy.json");
}

/** Loads persisted always-allow entries. Tolerant: missing file -> empty; corrupt/invalid file
 *  -> warn once and treat as empty. Never throws. */
function loadAlwaysAllow(): AlwaysAllowEntry[] {
  const path = policyPath();
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const parsed = PolicyFileSchema.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.message);
    return parsed.data.alwaysAllow;
  } catch (err) {
    if (!warnedCorrupt) {
      warnedCorrupt = true;
      console.warn(`claurp: ignoring unreadable policy file at ${path}: ${(err as Error).message}`);
    }
    return [];
  }
}

export class PermissionPolicy {
  private readonly alwaysAllow: AlwaysAllowEntry[];

  constructor() {
    this.alwaysAllow = loadAlwaysAllow();
  }

  /** hardDeny always wins, before class or any stored always-allow entry is even consulted --
   *  the deny-list cannot be bypassed by policy or by a persisted "always allow". */
  decide(tool: string, detail: string): Verdict {
    if (hardDeny(tool, detail)) return { action: "ask", alwaysable: false };

    const cls = classify(tool, detail);
    if (cls === "read") return { action: "auto-allow" };
    if (this.hasAlwaysAllow(tool, cls)) return { action: "auto-allow" };
    return { action: "ask", alwaysable: true };
  }

  /** Persists a tool+class always-allow decision. Refuses (and stores nothing) for anything
   *  matching the hard deny-list -- the deny-list is never "always"-able. */
  recordAlways(tool: string, detail: string): boolean {
    if (hardDeny(tool, detail)) return false;

    const cls = classify(tool, detail);
    if (!this.hasAlwaysAllow(tool, cls)) {
      this.alwaysAllow.push({ tool, class: cls });
      this.persist();
    }
    return true;
  }

  private hasAlwaysAllow(tool: string, cls: RiskClass): boolean {
    return this.alwaysAllow.some((e) => e.tool === tool && e.class === cls);
  }

  private persist(): void {
    const path = policyPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ alwaysAllow: this.alwaysAllow }, null, 2));
  }
}
