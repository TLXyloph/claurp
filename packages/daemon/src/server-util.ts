// Standalone WS/OS helpers for server.ts, split out (fix round: server.ts crept over the
// 500-line limit once the pump-error-isolation fix landed) so server.ts stays focused on
// connection/dispatch orchestration. No DaemonServer state lives here.
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { RawData, WebSocketServer } from "ws";

/** Test/introspection seam for the loopback-only bind fix -- `null` before start()/after stop(). */
export function wssAddress(wss: WebSocketServer | null): AddressInfo | string | null {
  return wss ? wss.address() : null;
}

export function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Embeds `cmd` in an AppleScript double-quoted string literal safely (escapes backslashes and
 *  quotes). Used instead of a hand-built shell string -- see runHandoffTerminal() below. */
function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** spec §5.3 handoff: opens Terminal.app and runs `cmd` there via AppleScript. Uses execFile
 *  (argv, no shell) rather than a shell string, so `cmd` never needs shell quoting at all --
 *  only the AppleScript string-literal escaping above is needed. */
export function runHandoffTerminal(cmd: string): void {
  const escaped = escapeAppleScriptString(cmd);
  execFile(
    "osascript",
    ["-e", `tell application "Terminal" to do script "${escaped}"`, "-e", 'tell application "Terminal" to activate'],
    (err) => {
      if (err) console.warn(`claurp: failed to open Terminal for handoff: ${err.message}`);
    },
  );
}
