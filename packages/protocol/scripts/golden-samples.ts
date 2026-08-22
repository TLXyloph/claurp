// Golden-fixture samples. One entry per wire shape; every enum variant of
// every message type must appear at least once (test/golden.test.ts enforces).
// Written as the daemon writes them (pre-zod-parse), so optional fields may
// be absent — the Swift decoder must handle both presence and absence.
import { PROTOCOL_VERSION } from "../src/messages.js";

const v = PROTOCOL_VERSION;

export const PCM_PATTERN = [0, 1, -1, 2, -2, 32767, -32768, 12345, -12345, 256];

export const daemonToSenses: Array<{ file: string; msg: unknown }> = [
  { file: "hello.ack", msg: { v, type: "hello.ack", daemonVersion: "0.1.0" } },

  { file: "state-idle", msg: { v, type: "state", mode: "idle" } },
  { file: "state-listening", msg: { v, type: "state", mode: "listening" } },
  { file: "state-working", msg: { v, type: "state", mode: "working" } },
  { file: "state-needs-you", msg: { v, type: "state", mode: "needs-you" } },
  { file: "state-disconnected", msg: { v, type: "state", mode: "disconnected" } },

  { file: "transcript-partial", msg: { v, type: "transcript.partial", text: "open the" } },
  { file: "transcript-final", msg: { v, type: "transcript.final", text: "open the notes file" } },

  { file: "earcon-wake-ack", msg: { v, type: "earcon", kind: "wake-ack" } },
  { file: "earcon-shutter", msg: { v, type: "earcon", kind: "shutter" } },
  { file: "earcon-permission-ask", msg: { v, type: "earcon", kind: "permission-ask" } },
  { file: "earcon-done", msg: { v, type: "earcon", kind: "done" } },

  { file: "hud-session-spawning", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "spawning", permissionMode: "default", narration: "Spinning up." } },
  { file: "hud-session-working", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "working", permissionMode: "acceptEdits", narration: "Editing the file." } },
  { file: "hud-session-needs-permission", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "needs-permission", permissionMode: "bypassPermissions", narration: "Waiting on you." } },
  { file: "hud-session-needs-input", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "needs-input", permissionMode: "plan", narration: "Question for you." } },
  { file: "hud-session-done", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "done", permissionMode: "default" } },
  { file: "hud-session-failed", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "failed", permissionMode: "default", narration: "It failed." } },
  { file: "hud-session-handed-off", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "handed-off", permissionMode: "default", narration: "In your terminal." } },

  { file: "hud-permission", msg: { v, type: "hud.permission", sessionId: "s-1", requestId: "r-1", tool: "Bash", detail: "rm -r build/", spoken: "The agent wants to delete the build folder." } },

  { file: "notify-permission", msg: { v, type: "notify", title: "notes app needs permission", body: "Bash: rm -r build/", sessionId: "s-1", requestId: "r-1", actions: ["allow", "deny"] } },
  { file: "notify-plain", msg: { v, type: "notify", title: "claurp", body: "Session finished." } },
  { file: "notify-open-terminal", msg: { v, type: "notify", title: "notes app", body: "Ready for review.", sessionId: "s-1", actions: ["allow", "deny", "open-terminal"] } },

  { file: "speak.stop", msg: { v, type: "speak.stop" } },
];

export const sensesToDaemon: Array<{ file: string; msg: unknown }> = [
  { file: "hello", msg: { v, type: "hello", client: "senses-macos", protocol: v } },
  { file: "ptt-down", msg: { v, type: "ptt", action: "down" } },
  { file: "ptt-up", msg: { v, type: "ptt", action: "up" } },
  { file: "permission-response-allow", msg: { v, type: "permission.response", sessionId: "s-1", requestId: "r-1", decision: "allow" } },
  { file: "permission-response-deny", msg: { v, type: "permission.response", sessionId: "s-1", requestId: "r-1", decision: "deny" } },
  { file: "permission-response-always", msg: { v, type: "permission.response", sessionId: "s-1", requestId: "r-1", decision: "always" } },
];

export const frames: Array<{ file: string; type: number; pcm: number[] }> = [
  { file: "mic", type: 0x01, pcm: PCM_PATTERN },
  { file: "tts", type: 0x02, pcm: PCM_PATTERN },
];
