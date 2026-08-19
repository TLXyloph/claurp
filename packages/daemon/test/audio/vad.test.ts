import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { int16ToFloat32, readWavPcm16Mono } from "../../src/audio/pcm.js";
import { modelPath } from "../../src/paths.js";
import { createSileroVad } from "../../src/audio/vad.js";

const FIX = join(import.meta.dirname, "..", "fixtures");
const haveModel = existsSync(modelPath("silero_vad.onnx"));

describe.skipIf(!haveModel)("silero vad", () => {
  function frames(file: string): Float32Array[] {
    const { pcm } = readWavPcm16Mono(join(FIX, file));
    const f32 = int16ToFloat32(pcm);
    const out: Float32Array[] = [];
    for (let i = 0; i + 512 <= f32.length; i += 512) out.push(f32.slice(i, i + 512));
    return out;
  }

  it("flags speech in a spoken fixture and none in silence", async () => {
    const vad = await createSileroVad();
    const speechHits = frames("plain_speech.wav").filter((f) => vad.isSpeech(f)).length;
    vad.reset();
    const silenceHits = frames("silence_2s.wav").filter((f) => vad.isSpeech(f)).length;
    expect(speechHits).toBeGreaterThan(10);
    expect(silenceHits).toBe(0);
  });
});
