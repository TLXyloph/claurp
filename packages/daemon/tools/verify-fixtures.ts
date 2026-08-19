import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readWavPcm16Mono } from "../src/audio/pcm.js";

const FIX = join(import.meta.dirname, "..", "test", "fixtures");

const files = readdirSync(FIX).filter(f => f.endsWith(".wav") && !f.startsWith("_raw_"));

console.log("Verifying fixtures...\n");

for (const file of files) {
  const path = join(FIX, file);
  const { sampleRate, pcm } = readWavPcm16Mono(path);

  console.log(`${file}:`);
  console.log(`  sampleRate: ${sampleRate} (expected 16000) ${sampleRate === 16000 ? "✓" : "✗"}`);
  console.log(`  samples: ${pcm.length}`);

  if (file === "silence_2s.wav") {
    const isAllZeros = Array.from(pcm).every(v => v === 0);
    const expectedSamples = 32000;
    console.log(`  isAllZeros: ${isAllZeros} (expected true) ${isAllZeros ? "✓" : "✗"}`);
    console.log(`  length: ${pcm.length} (expected ${expectedSamples}) ${pcm.length === expectedSamples ? "✓" : "✗"}`);
  } else {
    const isSpokenFile = file !== "silence_2s.wav";
    if (isSpokenFile) {
      const peakAmplitude = Math.max(...Array.from(pcm).map(v => Math.abs(v)));
      console.log(`  peakAmplitude: ${peakAmplitude} (expected > 1000) ${peakAmplitude > 1000 ? "✓" : "✗"}`);
      console.log(`  duration: ${(pcm.length / sampleRate).toFixed(2)}s (expected > 1s) ${pcm.length > 16000 ? "✓" : "✗"}`);
    }
  }
  console.log();
}

console.log("Verification complete!");
