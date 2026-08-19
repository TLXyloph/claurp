// Manual demo client (Task 16 Step 5): starts a real DaemonServer (production pipeline + real
// Kokoro TTS), connects as a fake senses client, streams silence + the
// "hey claude, create a file..." fixture + silence as mic frames in real-time-ish 32ms ticks,
// prints every JSON message received, auto-allows the first permission ask after ~2s, and
// writes every received TTS frame to demo-out.wav so you can `afplay` the daemon's voice.
//
//   pnpm --filter @claurp/daemon demo                    # FakeAgent (default, no API calls)
//   pnpm --filter @claurp/daemon demo -- --adapter claude # real Claude Code, needs a login
import { join } from "node:path";
import {
  BIN_MIC_PCM16_16K,
  BIN_TTS_PCM16_24K,
  PROTOCOL_VERSION,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from "@claurp/protocol";
import { WebSocket } from "ws";
import { buildProductionDaemonDeps } from "../src/build-deps.js";
import { concatInt16, readWavPcm16Mono, silence, writeWavPcm16Mono } from "../src/audio/pcm.js";
import { DaemonServer } from "../src/server.js";

const FRAME_SAMPLES = 512; // 32ms @ 16kHz
const TICK_MS = 32;
const ALLOW_DELAY_MS = 2000;
const DONE_WAIT_TIMEOUT_MS = 15_000;

function parseArgs(argv: string[]): { adapter: string } {
  let adapter = "fake";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--adapter" && argv[i + 1] !== undefined) adapter = argv[++i];
  }
  return { adapter };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { deps, transcriber, tts } = await buildProductionDaemonDeps({ defaultAdapter: args.adapter });
  const server = new DaemonServer(deps, { port: 0 });
  const port = await server.start();
  console.log(`claurp-daemon (demo, adapter=${args.adapter}) listening on ws://127.0.0.1:${port}`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const ttsChunks: Int16Array[] = [];
  let allowSent = false;
  let sawDone = false;

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", client: "demo", protocol: PROTOCOL_VERSION }));

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const { type, pcm } = decodeBinaryFrame(buf);
      if (type === BIN_TTS_PCM16_24K) ttsChunks.push(pcm);
      return;
    }
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    console.log(JSON.stringify(msg));

    if (msg.type === "hud.permission" && !allowSent) {
      allowSent = true;
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "permission.response",
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            decision: "allow",
          }),
        );
      }, ALLOW_DELAY_MS);
    }
    if (msg.type === "notify" && typeof msg.title === "string" && msg.title.includes("done")) {
      sawDone = true;
    }
  });

  const fixture = readWavPcm16Mono(join(import.meta.dirname, "..", "test", "fixtures", "hey_claude_create_file.wav"));
  const stream = concatInt16([silence(16000, 1), fixture.pcm, silence(16000, 3)]);
  for (let offset = 0; offset + FRAME_SAMPLES <= stream.length; offset += FRAME_SAMPLES) {
    const frame = stream.slice(offset, offset + FRAME_SAMPLES) as Int16Array;
    ws.send(encodeBinaryFrame(BIN_MIC_PCM16_16K, frame));
    await sleep(TICK_MS);
  }

  const deadline = Date.now() + DONE_WAIT_TIMEOUT_MS;
  while (!sawDone && Date.now() < deadline) await sleep(200);
  await sleep(500); // let any trailing TTS chunks finish arriving

  const outPath = join(import.meta.dirname, "..", "demo-out.wav");
  const samples = concatInt16(ttsChunks);
  writeWavPcm16Mono(outPath, 24000, samples);
  console.log(`wrote ${samples.length} samples (${(samples.length / 24000).toFixed(2)}s) to ${outPath}`);

  ws.close();
  await server.stop();
  tts.dispose();
  await transcriber.stop();
  process.exit(0);
}

void main();
