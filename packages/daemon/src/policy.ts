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
const BASH_NETWORK_RE = /\b(curl|wget|https?:\/\/)/;

export function classify(tool: string, detail: string): RiskClass {
  if (READ_TOOLS.has(tool)) return "read";
  if (WRITE_TOOLS.has(tool)) return "write";
  if (NETWORK_TOOLS.has(tool)) return "network";
  if (tool === "Bash") return BASH_NETWORK_RE.test(detail) ? "network" : "exec";
  return "exec"; // unknown tools: conservative
}

// spec §5.4 hard deny-list. Bash-only shell-command patterns:
const RM_RF_RE = /\brm\s+-[a-z]*[rf][a-z]*[rf]?\b/;
const GIT_CLEAN_F_RE = /\bgit\s+clean\b.*-[a-z]*f/;
const GIT_PUSH_FORCE_RE = /\bgit\s+push\b.*(--force|-f\b)/;
const GIT_HISTORY_REWRITE_RE = /\bgit\s+(reset\s+--hard|rebase|filter-branch)\b/;
const GIT_CHECKOUT_DISCARD_RE = /\bgit\s+checkout\s+--\s/;

// Secret-path token, checked for Read and Bash. Boundary-anchored on both sides so it only
// matches a path-ish token, not an arbitrary substring:
//  - start: "^", whitespace, or "/" (start of a path segment or shell argument).
//  - end (for the bare "credentials"/"secrets" words only): a lookahead for "/", ".",
//    whitespace, or end-of-string -- deliberately NOT a plain "\b". A plain word boundary
//    already fires at a word-char -> non-word-char transition, and "-" is non-word, so
//    "secrets\b" would match inside "secrets-policy" (the "s"→"-" transition is itself a
//    boundary). The doc filename "docs/secrets-policy.md" is exactly this false positive --
//    it *mentions* "secrets" in a hyphenated compound but isn't a secrets path. Requiring the
//    character after the word to be a real path/argument separator (not a hyphen) excludes
//    that compound while still matching real paths like "secrets/api_key" or "credentials.json".
//  - the extension-based alternatives (.env, .pem, .key, id_rsa/id_ed25519) are already
//    self-bounded by their literal suffix, so they don't need the same lookahead.
const SECRET_PATH_RE =
  /(^|[\s/])(\.env(\.[\w-]+)?|id_(rsa|ed25519)|[\w-]+\.pem|[\w-]+\.key|credentials?(?=[/.\s]|$)|secrets?(?=[/.\s]|$))/i;

export function hardDeny(tool: string, detail: string): boolean {
  if (tool === "Bash") {
    if (RM_RF_RE.test(detail)) return true;
    if (GIT_CLEAN_F_RE.test(detail)) return true;
    if (GIT_PUSH_FORCE_RE.test(detail)) return true;
    if (GIT_HISTORY_REWRITE_RE.test(detail)) return true;
    if (GIT_CHECKOUT_DISCARD_RE.test(detail)) return true;
  }
  if ((tool === "Read" || tool === "Bash") && SECRET_PATH_RE.test(detail)) return true;
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
