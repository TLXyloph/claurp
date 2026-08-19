// Heavy end-to-end test (Task 16 Step 5): automates the exact flow tools/demo.ts drives by
// hand -- a real DaemonServer wired to the real production pipeline (real VAD/wake/turn/whisper
// models) and real Kokoro TTS, FakeAgent as the default adapter, and a real `ws` client that
// streams the "hey claude, create a file..." fixture as mic frames. Model-gated: skipped unless
// every model this needs (audio pipeline + the cached Kokoro weights) is present on disk -- see
// pipeline.integration.test.ts for the same gating pattern.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, encodeBinaryFrame, BIN_MIC_PCM16_16K } from "@claurp/protocol";
import { WebSocket } from "ws";
import { buildProductionDaemonDeps } from "../src/build-deps.js";
import { concatInt16, readWavPcm16Mono, silence } from "../src/audio/pcm.js";
import { claurpHome, modelPath } from "../src/paths.js";
import { DaemonServer } from "../src/server.js";

const FIX = join(import.meta.dirname, "fixtures");

const ready =
  existsSync(modelPath("silero_vad.onnx")) &&
  existsSync(modelPath("smart-turn-v3.onnx")) &&
  existsSync(modelPath("ggml-base.en.bin")) &&
  existsSync(
    join(claurpHome(), "models", "hf", "onnx-community", "Kokoro-82M-v1.0-ONNX", "onnx", "model_quantized.onnx"),
  ) &&
  // buildProductionDaemonDeps() calls loadProjects(), which needs ~/.claurp/config.json to
  // exist (see sessions/projects.ts) -- a dev machine with models fetched but no projects
  // configured yet should skip this test the same way a missing model does, not hard-fail it.
  existsSync(join(claurpHome(), "config.json"));

type Msg = Record<string, unknown>;

async function waitFor(getMessages: () => Msg[], predicate: (m: Msg) => boolean, timeoutMs: number): Promise<Msg> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = getMessages().find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!ready)("daemon e2e (FakeAgent, real audio pipeline + real Kokoro TTS)", () => {
  it(
    "wake word -> transcript -> permission ask -> allow -> done, over a real WS connection",
    async () => {
      const { deps, transcriber, tts } = await buildProductionDaemonDeps({ defaultAdapter: "fake" });
      const server = new DaemonServer(deps, { port: 0 });
      const port = await server.start();

      const messages: Msg[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("message", (data, isBinary) => {
        if (isBinary) return; // e2e only asserts on JSON messages; TTS audio is demo.ts's concern
        messages.push(JSON.parse(data.toString()) as Msg);
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", client: "e2e", protocol: PROTOCOL_VERSION }));
      await waitFor(() => messages, (m) => m.type === "hello.ack", 5000);

      const fixture = readWavPcm16Mono(join(FIX, "hey_claude_create_file.wav"));
      const stream = concatInt16([silence(16000, 1), fixture.pcm, silence(16000, 3)]);
      for (let offset = 0; offset + 512 <= stream.length; offset += 512) {
        ws.send(encodeBinaryFrame(BIN_MIC_PCM16_16K, stream.slice(offset, offset + 512) as Int16Array));
      }

      const final = await waitFor(
        () => messages,
        (m) => m.type === "transcript.final" && typeof m.text === "string",
        60_000,
      );
      // whisper mis-transcribes the trailing "haiku" nondeterministically (~40% of runs
      // produce "hyper inid"/"hiker"/etc. instead), so we anchor on "file" and "notes",
      // reliably-transcribed mid-utterance tokens (25/25 in a 25-run characterization).
      expect((final.text as string).toLowerCase()).toContain("file");
      expect((final.text as string).toLowerCase()).toContain("notes");

      const permission = await waitFor(
        () => messages,
        (m) => m.type === "hud.permission" && m.tool === "Write",
        20_000,
      );
      expect(permission.tool).toBe("Write");

      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "permission.response",
          sessionId: permission.sessionId,
          requestId: permission.requestId,
          decision: "allow",
        }),
      );

      const done = await waitFor(
        () => messages,
        (m) => m.type === "notify" && typeof m.title === "string" && (m.title as string).includes("done"),
        20_000,
      );
      expect(done.title).toContain("done");

      ws.close();
      await server.stop();
      tts.dispose();
      await transcriber.stop();
    },
    180_000,
  );
});
