import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AudioPipeline, type PipelineEvent } from "../../src/audio/pipeline.js";
import { concatInt16, readWavPcm16Mono, silence } from "../../src/audio/pcm.js";
import { modelPath } from "../../src/paths.js";
import { createSileroVad } from "../../src/audio/vad.js";
import { createWakeSpotter } from "../../src/audio/wake.js";
import { createSmartTurn } from "../../src/audio/turn.js";
import { createWhisperTranscriber, type Transcriber } from "../../src/audio/transcriber.js";

const FIX = join(import.meta.dirname, "..", "fixtures");
const ready =
  existsSync(modelPath("silero_vad.onnx")) &&
  existsSync(modelPath("smart-turn-v3.onnx")) &&
  existsSync(modelPath("ggml-base.en.bin"));

describe.skipIf(!ready)("pipeline integration (real models)", () => {
  let t: Transcriber;
  beforeAll(async () => { t = createWhisperTranscriber({ port: 17772 }); await t.start(); });
  afterAll(async () => { await t.stop(); });

  it("wav in → wake + final transcript out", async () => {
    const events: PipelineEvent[] = [];
    const p = new AudioPipeline(
      { vad: await createSileroVad(), wake: await createWakeSpotter(), transcriber: t, turn: await createSmartTurn() },
      (e) => events.push(e),
    );
    const utterance = readWavPcm16Mono(join(FIX, "hey_claude_create_file.wav")).pcm;
    const stream = concatInt16([silence(16000, 1), utterance, silence(16000, 3)]);
    for (let i = 0; i + 512 <= stream.length; i += 512) await p.feed(stream.slice(i, i + 512) as Int16Array);
    expect(events.some((e) => e.kind === "wake")).toBe(true);
    const final = events.find((e) => e.kind === "final") as { kind: "final"; text: string } | undefined;
    expect(final).toBeDefined();
    expect(final!.text.toLowerCase()).toContain("haiku");
    expect(final!.text.toLowerCase()).not.toContain("hey claude");
  }, 180_000);
});
