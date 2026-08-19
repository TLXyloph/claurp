import { describe, expect, it } from "vitest";
import { createKokoroTts } from "../../src/tts/kokoro.js";

describe.skipIf(process.env.CLAURP_SKIP_TTS === "1")("kokoro tts", () => {
  it("synthesizes audible PCM for a short line", async () => {
    const tts = await createKokoroTts();
    let samples = 0, peak = 0;
    for await (const chunk of tts.synthesize("claurp is ready.")) {
      samples += chunk.length;
      for (const s of chunk) peak = Math.max(peak, Math.abs(s));
    }
    expect(samples).toBeGreaterThan(8000);   // > 1/3 s at 24 kHz
    expect(peak).toBeGreaterThan(500);       // not silence
  }, 600_000);
});
