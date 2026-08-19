// Intent router (verb grammar). Pure function, no LLM, no fuzzy matching (spec §4: no LLM in
// the hot path) -- every verb below is an anchored regex copied straight from the frozen test
// table (task-8-brief.md Step 3). Pipeline: normalize -> peel optional project prefix -> match
// anchored regexes in priority order (permission -> mode -> meta -> session -> capture ->
// prompt fallback). Whole-utterance anchoring (^...$) everywhere except "new task" (captures
// the remainder) and "switch to" (captures the target) -- that anchoring is what keeps a
// near-miss like "please allow more logging in the app" a prompt instead of a permission.
import type { Intent } from "@claurp/protocol";

// spec §5.1: leading "in <project-name>," (or ":") routes by named project. Peeled BEFORE verb
// matching; the captured name is re-attached only to `prompt` and `session/new` results below.
const PROJECT_PREFIX = /^in\s+([\w-]+)[,:]?\s+/;

function normalize(raw: string): string {
  const lowered = raw.toLowerCase().trim();
  const noTerminalPunct = lowered.replace(/[.,!?;:]+$/, "").trim();
  return noTerminalPunct.replace(/\s+/g, " ");
}

function peelProject(text: string): { text: string; project?: string } {
  const match = PROJECT_PREFIX.exec(text);
  if (!match) return { text };
  return { text: text.slice(match[0].length), project: match[1] };
}

function matchPermission(text: string): Intent | null {
  if (/^(allow always|always allow)$/.test(text)) return { kind: "permission", decision: "always" };
  if (/^(allow|yes)$/.test(text)) return { kind: "permission", decision: "allow" };
  if (/^(deny|no)$/.test(text)) return { kind: "permission", decision: "deny" };
  if (/^what exactly$/.test(text)) return { kind: "permission", decision: "detail" };
  return null;
}

function matchMode(text: string): Intent | null {
  if (/^plan mode$/.test(text)) return { kind: "mode", mode: "plan", confirmed: true };
  if (/^auto[ -]accept edits$/.test(text)) return { kind: "mode", mode: "acceptEdits", confirmed: true };
  if (/^normal mode$/.test(text)) return { kind: "mode", mode: "default", confirmed: true };
  if (/^confirm bypass$/.test(text)) return { kind: "mode", mode: "bypassPermissions", confirmed: true };
  if (/^bypass permissions$/.test(text)) return { kind: "mode", mode: "bypassPermissions", confirmed: false };
  return null;
}

function matchMeta(text: string): Intent | null {
  if (/^(status|what's the status)$/.test(text)) return { kind: "meta", query: "status" };
  if (/^(usage|how much have i used this week)$/.test(text)) return { kind: "meta", query: "usage" };
  if (/^how full is this session$/.test(text)) return { kind: "meta", query: "contextFill" };
  return null;
}

function matchSession(text: string, project?: string): Intent | null {
  const newTask = /^new task:?\s+(.+)$/.exec(text);
  if (newTask) {
    return project
      ? { kind: "session", op: "new", prompt: newTask[1], project }
      : { kind: "session", op: "new", prompt: newTask[1] };
  }
  if (/^(kill it|stop that)$/.test(text)) return { kind: "session", op: "kill" };
  const switchTo = /^switch to (.+)$/.exec(text);
  if (switchTo) return { kind: "session", op: "switch", target: switchTo[1] };
  if (/^(show me the session|open it in the terminal)$/.test(text)) return { kind: "session", op: "handoff" };
  return null;
}

function matchCapture(text: string): Intent | null {
  if (/^look at my screen$/.test(text)) return { kind: "capture", target: "screen" };
  if (/^check this out$/.test(text)) return { kind: "capture", target: "camera" };
  return null;
}

export function parseIntent(raw: string): Intent {
  const { text, project } = peelProject(normalize(raw));

  return (
    matchPermission(text) ??
    matchMode(text) ??
    matchMeta(text) ??
    matchSession(text, project) ??
    matchCapture(text) ??
    (project ? { kind: "prompt", text, project } : { kind: "prompt", text })
  );
}
