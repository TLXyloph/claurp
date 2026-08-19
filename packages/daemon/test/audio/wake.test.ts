import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { int16ToFloat32, readWavPcm16Mono } from "../../src/audio/pcm.js";
import { modelPath } from "../../src/paths.js";
import { createWakeSpotter } from "../../src/audio/wake.js";

const FIX = join(import.meta.dirname, "..", "fixtures");
const KWS_DIR = modelPath("sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01");

function runOver(file: string, spotter: { feed(f: Float32Array): string | null }): string | null {
  const f32 = int16ToFloat32(readWavPcm16Mono(join(FIX, file)).pcm);
  for (let i = 0; i + 512 <= f32.length; i += 512) {
    const hit = spotter.feed(f32.slice(i, i + 512));
    if (hit) return hit;
  }
  return null;
}

describe.skipIf(!existsSync(KWS_DIR))("wake spotter", () => {
  it("fires on 'hey claude' and stays quiet on unrelated speech and silence", async () => {
    const s = await createWakeSpotter();
    expect(runOver("hey_claude.wav", s)).toBe("HEY_CLAUDE");
    s.reset();
    expect(runOver("plain_speech.wav", s)).toBeNull();
    s.reset();
    expect(runOver("silence_2s.wav", s)).toBeNull();
  });

  it("fires when the wake phrase leads a longer utterance", async () => {
    const s = await createWakeSpotter();
    expect(runOver("hey_claude_create_file.wav", s)).toBe("HEY_CLAUDE");
  });
});
