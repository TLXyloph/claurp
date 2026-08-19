// Fast DaemonServer test (Task 16 Step 1): fake pipelineFactory (captures onEvent, returns a
// stub PipelineLike so no real audio models are touched), FakeAgent as the "fake" adapter, real
// Narrator/PermissionPolicy/MeterService against a tmp CLAURP_HOME, and a stub TtsEngine (one
// small chunk per synthesize() call, with a short delay so the "wake aborts mid-flight" case is
// exercised meaningfully). A real `ws` client drives the whole dispatch-contract table end to
// end over an ephemeral port.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterCapabilities, AgentAdapter, AgentEvent, SessionHandle, SpawnOpts } from "@claurp/protocol";
import { BIN_TTS_PCM16_24K, PROTOCOL_VERSION, decodeBinaryFrame } from "@claurp/protocol";
import { WebSocket } from "ws";
import { FakeAgent } from "../src/agents/fake.js";
import type { PipelineEvent } from "../src/audio/pipeline.js";
import { MeterService } from "../src/meter.js";
import { Narrator } from "../src/narrator.js";
import { PermissionPolicy } from "../src/policy.js";
import { DaemonServer, type DaemonDeps, type PipelineLike } from "../src/server.js";
import type { TtsEngine } from "../src/tts/kokoro.js";

type Msg = Record<string, unknown>;

function stubTts(): TtsEngine {
  return {
    async *synthesize(_text: string) {
      // Small delay before the (single) chunk, so a wake fired right after triggering a speak()
      // lands genuinely "mid-flight" instead of racing a synchronously-resolved generator.
      await new Promise((resolve) => setTimeout(resolve, 30));
      yield new Int16Array(100);
    },
    stop(): void {
      // no-op: the abort itself is driven by DaemonServer's own ttsAbortToken, not by this stub.
    },
  };
}

const THROWING_CAPABILITIES: AdapterCapabilities = {
  images: false,
  permissions: "callback",
  resume: false,
  queuedInput: true,
  permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
};

// Regression fixture for the pump-error-isolation fix: an adapter whose events() async
// iterator REJECTS mid-stream (a transport dying), as opposed to emitting an in-band
// {kind:"error"} event. Before the fix this was an unhandled rejection out of pumpSession()'s
// un-try/caught `for await`.
class ThrowingAgent implements AgentAdapter {
  readonly name = "throwing";

  capabilities(): AdapterCapabilities {
    return THROWING_CAPABILITIES;
  }

  spawn(_opts: SpawnOpts): SessionHandle {
    return {
      send: () => {},
      interrupt: () => {},
      setPermissionMode: () => {},
      respondPermission: () => {},
      events(): AsyncIterable<AgentEvent> {
        return {
          async *[Symbol.asyncIterator]() {
            yield { kind: "started", backendSessionId: null };
            throw new Error("transport died");
          },
        };
      },
      handoffCommand: () => null,
      kill: () => {},
    };
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("DaemonServer", () => {
  let server: DaemonServer;
  let ws: WebSocket;
  let messages: Msg[];
  let ttsFrames: number;
  let onEvent: (e: PipelineEvent) => void;

  function countWhere(pred: (m: Msg) => boolean): number {
    return messages.filter(pred).length;
  }

  beforeEach(async () => {
    process.env.CLAURP_HOME = mkdtempSync(join(tmpdir(), "claurp-server-test-"));

    const project = { name: "demo", cwd: process.cwd() };
    const adapters = new Map<string, AgentAdapter>([["fake", new FakeAgent()]]);

    const deps: DaemonDeps = {
      pipelineFactory: async (cb) => {
        onEvent = cb;
        const stub: PipelineLike = { feed: async () => {}, pttDown: () => {}, pttUp: async () => {} };
        return stub;
      },
      adapters,
      defaultAdapter: "fake",
      projects: { defaultProject: project, byName: new Map([["demo", project]]) },
      policy: new PermissionPolicy(),
      meter: new MeterService(),
      narrator: new Narrator(),
      tts: stubTts(),
    };

    server = new DaemonServer(deps, { port: 0 });
    const port = await server.start();

    messages = [];
    ttsFrames = 0;
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const { type } = decodeBinaryFrame(buf);
        if (type === BIN_TTS_PCM16_24K) ttsFrames++;
        return;
      }
      messages.push(JSON.parse(data.toString()) as Msg);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  });

  afterEach(async () => {
    ws.close();
    await server.stop();
  });

  it("drives hello, spawn+permission-ask, allow-to-done, and honest fallbacks end to end", async () => {
    // (a) hello -> hello.ack then state:idle
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", client: "test", protocol: PROTOCOL_VERSION }));
    await waitFor(() => countWhere((m) => m.type === "hello.ack") === 1);
    await waitFor(() => countWhere((m) => m.type === "state" && m.mode === "idle") === 1);

    // (b) final "create a file called notes.txt" -> spawn -> permission ask, fully broadcast
    onEvent({ kind: "final", text: "create a file called notes.txt" });

    await waitFor(() => messages.some((m) => m.type === "hud.session" && m.state === "spawning"));
    await waitFor(() => messages.some((m) => m.type === "hud.session" && m.state === "working"));
    await waitFor(() => messages.some((m) => m.type === "hud.permission" && m.tool === "Write"));
    const permissionMsg = messages.find((m) => m.type === "hud.permission")!;
    const sessionId = permissionMsg.sessionId as string;
    const requestId = permissionMsg.requestId as string;

    await waitFor(() =>
      messages.some((m) => m.type === "notify" && Array.isArray(m.actions) && (m.actions as string[]).length > 0),
    );
    await waitFor(() => messages.some((m) => m.type === "earcon" && m.kind === "permission-ask"));
    await waitFor(() => countWhere((m) => m.type === "state" && m.mode === "needs-you") >= 1);
    await waitFor(() => ttsFrames >= 1);

    // (c) permission.response allow -> session reaches done, notify/earcon/state follow
    const idleCountBeforeAllow = countWhere((m) => m.type === "state" && m.mode === "idle");
    ws.send(
      JSON.stringify({ v: PROTOCOL_VERSION, type: "permission.response", sessionId, requestId, decision: "allow" }),
    );

    await waitFor(() => messages.some((m) => m.type === "hud.session" && m.sessionId === sessionId && m.state === "done"));
    await waitFor(() =>
      messages.some((m) => m.type === "notify" && typeof m.title === "string" && (m.title as string).includes("done")),
    );
    await waitFor(() => messages.some((m) => m.type === "earcon" && m.kind === "done"));
    await waitFor(() => countWhere((m) => m.type === "state" && m.mode === "idle") > idleCountBeforeAllow);

    // (d) final "usage" -> a TTS frame, and no new session shows up afterward (checked via a
    // subsequent "status" pass over the roster)
    const sessionIdsBefore = new Set(messages.filter((m) => m.type === "hud.session").map((m) => m.sessionId));
    expect(sessionIdsBefore.size).toBe(1);

    let ttsBefore = ttsFrames;
    onEvent({ kind: "final", text: "usage" });
    await waitFor(() => ttsFrames > ttsBefore);

    ttsBefore = ttsFrames;
    onEvent({ kind: "final", text: "status" });
    await waitFor(() => ttsFrames > ttsBefore);

    const sessionIdsAfter = new Set(messages.filter((m) => m.type === "hud.session").map((m) => m.sessionId));
    expect(sessionIdsAfter.size).toBe(1);

    // (e) final "look at my screen" -> honest capture-unavailable narration, no crash
    ttsBefore = ttsFrames;
    onEvent({ kind: "final", text: "look at my screen" });
    await waitFor(() => ttsFrames > ttsBefore);

    // (f) wake while a TTS stream is mid-flight -> speak.stop observed
    const speakStopBefore = countWhere((m) => m.type === "speak.stop");
    onEvent({ kind: "final", text: "usage" }); // starts a new speak(); stub takes ~30ms to yield
    onEvent({ kind: "wake" }); // fires essentially immediately after, while that speak is in flight
    await waitFor(() => countWhere((m) => m.type === "speak.stop") > speakStopBefore);
  });
});

describe("DaemonServer session-pump error isolation (review fix round)", () => {
  it("marks the session failed when its event stream rejects mid-iteration, without crashing or skipping persist", async () => {
    process.env.CLAURP_HOME = mkdtempSync(join(tmpdir(), "claurp-server-pump-error-"));

    // Proves nothing escapes as a genuine unhandled rejection -- not just "the test didn't hang."
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const project = { name: "demo", cwd: process.cwd() };
    const adapters = new Map<string, AgentAdapter>([["throwing", new ThrowingAgent()]]);
    const meter = new MeterService();
    const persistSpy = vi.spyOn(meter, "persist");

    let onEvent!: (e: PipelineEvent) => void;
    const deps: DaemonDeps = {
      pipelineFactory: async (cb) => {
        onEvent = cb;
        const stub: PipelineLike = { feed: async () => {}, pttDown: () => {}, pttUp: async () => {} };
        return stub;
      },
      adapters,
      defaultAdapter: "throwing",
      projects: { defaultProject: project, byName: new Map([["demo", project]]) },
      policy: new PermissionPolicy(),
      meter,
      narrator: new Narrator(),
      tts: stubTts(),
    };

    const server = new DaemonServer(deps, { port: 0 });
    const port = await server.start();

    const messages: Msg[] = [];
    let ttsFrames = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const { type } = decodeBinaryFrame(buf);
        if (type === BIN_TTS_PCM16_24K) ttsFrames++;
        return;
      }
      messages.push(JSON.parse(data.toString()) as Msg);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    try {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", client: "test", protocol: PROTOCOL_VERSION }));
      await waitFor(() => messages.some((m) => m.type === "hello.ack"));

      // Spawns a session on the "throwing" adapter: its events() yields one "started" event,
      // then the async iterator itself rejects on the next pull -- the exact "transport died
      // mid-stream" scenario, not an in-band {kind:"error"} event.
      onEvent({ kind: "final", text: "do something" });

      await waitFor(() => messages.some((m) => m.type === "hud.session" && m.state === "working"));
      await waitFor(() => messages.some((m) => m.type === "hud.session" && m.state === "failed"));
      await waitFor(() =>
        messages.some((m) => m.type === "notify" && typeof m.title === "string" && (m.title as string).includes("error")),
      );
      await waitFor(() => persistSpy.mock.calls.length > 0);

      // Server stays up: a completely unrelated intent afterward still gets a normal response.
      const ttsBefore = ttsFrames;
      onEvent({ kind: "final", text: "usage" });
      await waitFor(() => ttsFrames > ttsBefore);

      // Give any straggler microtask a chance to surface before asserting "nothing escaped".
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      ws.close();
      await server.stop();
    }
  });
});
