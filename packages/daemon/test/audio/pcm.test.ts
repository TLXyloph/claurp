import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  concatInt16,
  int16ToFloat32,
  readWavPcm16Mono,
  silence,
  writeWavPcm16Mono,
} from "../../src/audio/pcm.js";

describe("pcm/wav utilities", () => {
  it("writes then reads a 16k mono wav losslessly", () => {
    const dir = mkdtempSync(join(tmpdir(), "claurp-"));
    const pcm = new Int16Array([0, 100, -100, 32767, -32768, 5]);
    const p = join(dir, "t.wav");
    writeWavPcm16Mono(p, 16000, pcm);
    const back = readWavPcm16Mono(p);
    expect(back.sampleRate).toBe(16000);
    expect(Array.from(back.pcm)).toEqual(Array.from(pcm));
  });

  it("converts int16 to float32 in [-1, 1]", () => {
    const f = int16ToFloat32(new Int16Array([0, 16384, -32768]));
    expect(f[0]).toBeCloseTo(0);
    expect(f[1]).toBeCloseTo(0.5, 2);
    expect(f[2]).toBeCloseTo(-1, 3);
  });

  it("concats and makes silence of the right length", () => {
    const s = silence(16000, 0.5);
    expect(s.length).toBe(8000);
    expect(concatInt16([s, s]).length).toBe(16000);
  });
});
