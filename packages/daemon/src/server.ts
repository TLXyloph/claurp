// Daemon WS server orchestration (Task 16, capstone): wires protocol (T1), the audio pipeline
// (T7), the intent router (T8), agent adapters (T9/T12), SessionManager (T10), PermissionPolicy
// (T11), MeterService (T13), Narrator (T14), and TTS (T15) into one WebSocket server. The
// dispatch-contract table in task-16-brief.md is the spec this file (plus server-dispatch.ts)
// implements exactly.
import { execFile } from "node:child_process";
import type { AgentAdapter, AgentEvent, DaemonToSensesMsg, SensesToDaemonMsg } from "@claurp/protocol";
import {
  BIN_MIC_PCM16_16K,
  BIN_TTS_PCM16_24K,
  PROTOCOL_VERSION,
  decodeBinaryFrame,
  encodeBinaryFrame,
  parseSensesMsg,
} from "@claurp/protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { concatInt16 } from "./audio/pcm.js";
import type { PipelineEvent } from "./audio/pipeline.js";
import { applyPermissionDecision, dispatchIntent, type DispatchContext } from "./server-dispatch.js";
import type { MeterService } from "./meter.js";
import type { Narrator } from "./narrator.js";
import { parseIntent } from "./router.js";
import type { PermissionPolicy, Verdict } from "./policy.js";
import { SessionManager, type SessionRecord } from "./sessions/manager.js";
import type { Project } from "./sessions/projects.js";
import { SentenceSplitter } from "./tts/sentences.js";
import type { TtsEngine } from "./tts/kokoro.js";

export interface PipelineLike {
  feed(f: Int16Array): Promise<void>;
  pttDown(): void;
  pttUp(): Promise<void>;
}

export interface DaemonDeps {
  pipelineFactory: (onEvent: (e: PipelineEvent) => void) => Promise<PipelineLike>; // test seam
  adapters: Map<string, AgentAdapter>;
  defaultAdapter: string;
  projects: { defaultProject: Project; byName: Map<string, Project> };
  policy: PermissionPolicy;
  meter: MeterService;
  narrator: Narrator;
  tts: TtsEngine;
}

type StateMode = "idle" | "listening" | "working" | "needs-you" | "disconnected";
type PermissionResponseMsg = Extract<SensesToDaemonMsg, { type: "permission.response" }>;

const DAEMON_VERSION = "0.1.0";
const FRAME_SAMPLES = 512; // 32ms @ 16kHz, matches AudioPipeline's frame size (T7)
const WATCHDOG_INTERVAL_MS = 5000;
const WATCHDOG_MAX_MISSED = 3;

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Embeds `cmd` in an AppleScript double-quoted string literal safely (escapes backslashes and
 *  quotes). Used instead of a hand-built shell string -- see runHandoffTerminal(). */
function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** spec §5.3 handoff: opens Terminal.app and runs `cmd` there via AppleScript. Uses execFile
 *  (argv, no shell) rather than a shell string, so `cmd` never needs shell quoting at all --
 *  only the AppleScript string-literal escaping above is needed. */
function runHandoffTerminal(cmd: string): void {
  const escaped = escapeAppleScriptString(cmd);
  execFile(
    "osascript",
    ["-e", `tell application "Terminal" to do script "${escaped}"`, "-e", 'tell application "Terminal" to activate'],
    (err) => {
      if (err) console.warn(`claurp: failed to open Terminal for handoff: ${err.message}`);
    },
  );
}

export class DaemonServer {
  private readonly manager: SessionManager;
  private wss: WebSocketServer | null = null;
  private pipeline: PipelineLike | null = null;

  private readonly clients = new Map<WebSocket, { missed: number }>();
  private primary: WebSocket | null = null;
  private micRemainder: Int16Array = new Int16Array(0);
  // Serializes every pipeline.feed()/pttDown()/pttUp() call. AudioPipeline.pttDown() (T7)
  // mutates state synchronously OUTSIDE its own internal feed()/pttUp() promise chain -- a
  // latent race if it ran concurrently with an in-flight feed(). The WS layer only has a single
  // authoritative mic source (the primary client, see clients/primary above), but its message
  // handlers are still separate async callbacks; this chain is what actually guarantees the
  // "one message at a time, strictly in arrival order" property T7's carry-forward note
  // requires, rather than just asserting it by convention.
  private pipelineChain: Promise<void> = Promise.resolve();

  private globalState: StateMode = "idle";
  private readonly lastNarration = new Map<string, string>();
  // Bumped only by abortSpeaking() (wake / explicit stop) -- NOT on every speak() call, so two
  // back-to-back narrations queue and both play instead of the second silently cancelling the
  // first.
  private ttsAbortToken = 0;
  private speakChain: Promise<void> = Promise.resolve();
  // Set by stop(). speak() calls queued-but-not-yet-started at that point would otherwise still
  // reach tts.synthesize() later -- a real problem for callers (cli.ts's SIGINT handler,
  // tools/demo.ts, test/e2e.test.ts) that call tts.dispose() right after awaiting stop().
  private stopped = false;

  private watchdogTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: DaemonDeps,
    private readonly opts: { port?: number } = {},
  ) {
    this.manager = new SessionManager(deps.adapters, { defaultAdapter: deps.defaultAdapter });
  }

  async start(): Promise<number> {
    this.pipeline = await this.deps.pipelineFactory((e) => this.onPipelineEvent(e));
    this.manager.onChange((record) => this.onSessionChange(record));

    this.wss = new WebSocketServer({ port: this.opts.port ?? 8765 });
    await new Promise<void>((resolve, reject) => {
      this.wss!.once("listening", resolve);
      this.wss!.once("error", reject);
    });
    this.wss.on("connection", (ws: WebSocket) => this.onConnection(ws));
    this.watchdogTimer = setInterval(() => this.tickWatchdog(), WATCHDOG_INTERVAL_MS);

    const address = this.wss.address();
    return typeof address === "object" && address !== null ? address.port : (this.opts.port ?? 8765);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abortSpeaking();
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    for (const ws of this.clients.keys()) ws.terminate();
    this.clients.clear();
    this.primary = null;
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  // ---- WS connection lifecycle -----------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    let helloDone = false;
    this.clients.set(ws, { missed: 0 });

    ws.on("pong", () => {
      const c = this.clients.get(ws);
      if (c) c.missed = 0;
    });
    ws.on("close", () => {
      this.clients.delete(ws);
      if (this.primary === ws) this.primary = null;
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!helloDone) {
        helloDone = this.handleHello(ws, data, isBinary);
        return;
      }
      this.onClientMessage(ws, data, isBinary);
    });
  }

  /** First message on a connection must be `hello` (spec dispatch table #1), else close 4000.
   *  Returns whether hello succeeded (becomes `helloDone` for the connection). */
  private handleHello(ws: WebSocket, data: RawData, isBinary: boolean): boolean {
    if (isBinary) {
      ws.close(4000, "expected hello");
      return false;
    }
    let msg: SensesToDaemonMsg;
    try {
      msg = parseSensesMsg(JSON.parse(toBuffer(data).toString()));
    } catch {
      ws.close(4000, "expected hello");
      return false;
    }
    if (msg.type !== "hello") {
      ws.close(4000, "expected hello");
      return false;
    }
    if (this.primary === null) this.primary = ws;
    this.send(ws, { v: PROTOCOL_VERSION, type: "hello.ack", daemonVersion: DAEMON_VERSION });
    this.send(ws, { v: PROTOCOL_VERSION, type: "state", mode: this.globalState });
    return true;
  }

  private onClientMessage(ws: WebSocket, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.handleBinary(ws, toBuffer(data));
      return;
    }
    let msg: SensesToDaemonMsg;
    try {
      msg = parseSensesMsg(JSON.parse(toBuffer(data).toString()));
    } catch (err) {
      console.warn(`claurp: dropping malformed message: ${(err as Error).message}`);
      return;
    }
    switch (msg.type) {
      case "hello":
        console.warn("claurp: ignoring duplicate hello");
        return;
      case "ptt":
        this.handlePtt(ws, msg.action);
        return;
      case "permission.response":
        this.handlePermissionResponse(msg);
        return;
    }
  }

  // ---- mic / ptt (spec dispatch table #2, #6, #7) ----------------------------------------

  private handleBinary(ws: WebSocket, buf: Buffer): void {
    if (ws !== this.primary) {
      console.warn("claurp: ignoring binary frame from a non-primary senses client");
      return;
    }
    let decoded: { type: number; pcm: Int16Array };
    try {
      decoded = decodeBinaryFrame(buf);
    } catch (err) {
      console.warn(`claurp: dropping malformed binary frame: ${(err as Error).message}`);
      return;
    }
    if (decoded.type !== BIN_MIC_PCM16_16K) return;

    const combined = concatInt16([this.micRemainder, decoded.pcm]);
    let offset = 0;
    while (offset + FRAME_SAMPLES <= combined.length) {
      const frame = combined.slice(offset, offset + FRAME_SAMPLES) as Int16Array;
      this.callPipeline(() => this.pipeline!.feed(frame));
      offset += FRAME_SAMPLES;
    }
    this.micRemainder = combined.slice(offset);
  }

  private handlePtt(ws: WebSocket, action: "down" | "up"): void {
    if (ws !== this.primary) {
      console.warn("claurp: ignoring ptt from a non-primary senses client");
      return;
    }
    if (action === "down") this.callPipeline(() => this.pipeline!.pttDown());
    else this.callPipeline(() => this.pipeline!.pttUp());
  }

  private callPipeline(fn: () => Promise<void> | void): void {
    this.pipelineChain = this.pipelineChain.then(() => fn()).catch((err: unknown) => {
      console.error("claurp: pipeline operation failed", err);
    });
  }

  private handlePermissionResponse(msg: PermissionResponseMsg): void {
    const record = this.manager.roster().find((r) => r.id === msg.sessionId);
    if (!record || !record.pendingPermission || record.pendingPermission.requestId !== msg.requestId) return;
    applyPermissionDecision(record, msg.decision, {
      manager: this.manager,
      policy: this.deps.policy,
      narrator: this.deps.narrator,
      speak: (t) => this.speak(t),
    });
  }

  // ---- PipelineEvent -> transcript/intent dispatch (spec dispatch table #3) --------------

  private onPipelineEvent(e: PipelineEvent): void {
    switch (e.kind) {
      case "wake":
        this.broadcast({ v: PROTOCOL_VERSION, type: "earcon", kind: "wake-ack" });
        this.setGlobalState("listening");
        this.broadcast({ v: PROTOCOL_VERSION, type: "speak.stop" });
        this.abortSpeaking();
        return;
      case "partial":
        this.broadcast({ v: PROTOCOL_VERSION, type: "transcript.partial", text: e.text });
        return;
      case "final":
        this.broadcast({ v: PROTOCOL_VERSION, type: "transcript.final", text: e.text });
        dispatchIntent(parseIntent(e.text), this.buildDispatchContext());
        return;
    }
  }

  private buildDispatchContext(): DispatchContext {
    return {
      manager: this.manager,
      projects: this.deps.projects,
      policy: this.deps.policy,
      meter: this.deps.meter,
      narrator: this.deps.narrator,
      speak: (t) => this.speak(t),
      spawn: (prompt, project) => this.spawnSession(prompt, project),
      runHandoffTerminal,
    };
  }

  private spawnSession(prompt: string, project: Project): SessionRecord {
    const record = this.manager.spawn({ prompt, project });
    void this.pumpSession(record);
    return record;
  }

  // ---- session event pump (spec dispatch table #4) ---------------------------------------

  private async pumpSession(record: SessionRecord): Promise<void> {
    for await (const e of record.handle.events()) {
      let verdict: Verdict | null = null;
      if (e.kind === "needs-permission") {
        verdict = this.deps.policy.decide(e.tool, e.detail);
        if (verdict.action === "ask") this.lastNarration.set(record.id, this.deps.narrator.permissionAsk(e.tool, e.detail));
      } else {
        const line = this.deps.narrator.onEvent(record.label, e);
        if (line !== null) this.lastNarration.set(record.id, line);
      }

      this.manager.noteActivity(record.id);
      this.manager.consume(record.id, e); // triggers onSessionChange -> hud.session (uses lastNarration above)

      if (e.kind === "usage-metadata") {
        this.deps.meter.record(record.id, e);
      } else if (e.kind === "needs-permission" && verdict) {
        this.handleNeedsPermission(record, e, verdict);
      } else if (e.kind === "done") {
        this.handleSessionDone(record, e);
      } else if (e.kind === "error") {
        this.broadcast({ v: PROTOCOL_VERSION, type: "notify", title: `${record.label} error`, body: e.message, sessionId: record.id, actions: [] });
        this.speak(this.deps.narrator.onEvent(record.label, e));
      }
    }
    this.deps.meter.persist();
    this.recomputeGlobalState();
  }

  private handleNeedsPermission(
    record: SessionRecord,
    e: Extract<AgentEvent, { kind: "needs-permission" }>,
    verdict: Verdict,
  ): void {
    if (verdict.action === "auto-allow") {
      this.manager.respondPermission(record.id, "allow"); // silently revert state (no UI, no speech)
      return;
    }
    const spoken = this.deps.narrator.permissionAsk(e.tool, e.detail);
    this.broadcast({
      v: PROTOCOL_VERSION,
      type: "hud.permission",
      sessionId: record.id,
      requestId: e.requestId,
      tool: e.tool,
      detail: e.detail,
      spoken,
    });
    this.broadcast({
      v: PROTOCOL_VERSION,
      type: "notify",
      title: `${record.label} needs permission`,
      body: `${e.tool}: ${e.detail}`,
      sessionId: record.id,
      requestId: e.requestId,
      actions: ["allow", "deny"],
    });
    this.broadcast({ v: PROTOCOL_VERSION, type: "earcon", kind: "permission-ask" });
    this.setGlobalState("needs-you");
    this.speak(spoken);
  }

  private handleSessionDone(record: SessionRecord, e: Extract<AgentEvent, { kind: "done" }>): void {
    this.broadcast({ v: PROTOCOL_VERSION, type: "earcon", kind: "done" });
    const cmd = record.handle.handoffCommand();
    this.broadcast({
      v: PROTOCOL_VERSION,
      type: "notify",
      title: `${record.label} done`,
      body: e.summary ?? "Finished.",
      sessionId: record.id,
      actions: cmd ? ["open-terminal"] : [],
    });
  }

  private onSessionChange(record: SessionRecord): void {
    this.broadcast({
      v: PROTOCOL_VERSION,
      type: "hud.session",
      sessionId: record.id,
      label: record.label,
      state: record.state,
      permissionMode: record.permissionMode,
      narration: this.lastNarration.get(record.id),
    });
  }

  private setGlobalState(mode: StateMode): void {
    this.globalState = mode;
    this.broadcast({ v: PROTOCOL_VERSION, type: "state", mode });
  }

  private recomputeGlobalState(): void {
    const roster = this.manager.roster();
    const needsYou = roster.some((r) => r.state === "needs-permission" || r.state === "needs-input");
    const working = roster.some((r) => r.state === "spawning" || r.state === "working");
    this.setGlobalState(needsYou ? "needs-you" : working ? "working" : "idle");
  }

  // ---- speak() (spec dispatch table #5) ---------------------------------------------------

  private speak(text: string | null): void {
    if (!text || this.stopped) return;
    this.speakChain = this.speakChain.then(() => this.runSpeak(text)).catch((err: unknown) => {
      console.error("claurp: speak failed", err);
    });
  }

  private async runSpeak(text: string): Promise<void> {
    if (this.stopped) return;
    const token = this.ttsAbortToken;
    const splitter = new SentenceSplitter();
    const sentences = splitter.push(text);
    const tail = splitter.flush();
    if (tail) sentences.push(tail);

    for (const sentence of sentences) {
      if (this.stopped || token !== this.ttsAbortToken) return;
      for await (const chunk of this.deps.tts.synthesize(sentence)) {
        if (this.stopped || token !== this.ttsAbortToken) return;
        this.broadcastBinary(encodeBinaryFrame(BIN_TTS_PCM16_24K, chunk));
      }
    }
  }

  private abortSpeaking(): void {
    this.ttsAbortToken++;
    this.deps.tts.stop();
  }

  // ---- watchdog (spec §3): ping every 5s, terminate after 3 missed pongs -----------------

  private tickWatchdog(): void {
    for (const [ws, info] of this.clients) {
      if (info.missed >= WATCHDOG_MAX_MISSED) {
        ws.terminate();
        this.clients.delete(ws);
        if (this.primary === ws) this.primary = null;
        continue;
      }
      info.missed++;
      ws.ping();
    }
  }

  // ---- broadcast (spec dispatch table #7): every daemon->senses message goes to all clients

  private broadcast(msg: DaemonToSensesMsg): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private broadcastBinary(buf: Buffer): void {
    for (const ws of this.clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
    }
  }

  private send(ws: WebSocket, msg: DaemonToSensesMsg): void {
    ws.send(JSON.stringify(msg));
  }
}
