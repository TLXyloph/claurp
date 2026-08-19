import { describe, expect, it } from "vitest";
import { melSpectrogram } from "../../src/audio/mel.js";

// Independent (not imported from mel.ts) re-derivation of the Slaney mel scale, used only to
// figure out which of the 80 output mel bins correspond to which approximate frequency, for
// the sine-wave property test below. Kept local to the test so mel.ts's only production export
// stays `melSpectrogram`.
function hertzToMelSlaney(freq: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = 27.0 / Math.log(6.4);
  return freq >= minLogHertz ? minLogMel + Math.log(freq / minLogHertz) * logstep : (3.0 * freq) / 200.0;
}
function melToHertzSlaney(mel: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = Math.log(6.4) / 27.0;
  return mel >= minLogMel ? minLogHertz * Math.exp(logstep * (mel - minLogMel)) : (200.0 * mel) / 3.0;
}
// Center (peak) frequency of mel filter `bin` (0..79) — see mel.ts's buildMelFilterbank for
// why the peak sits at the (bin+1)-th of 81 evenly-spaced mel-space gridpoints.
function melBinCenterHz(bin: number): number {
  const melMin = hertzToMelSlaney(0);
  const melMax = hertzToMelSlaney(8000);
  return melToHertzSlaney(melMin + ((melMax - melMin) * (bin + 1)) / 81);
}

const N_SAMPLES_8S = 16000 * 8;

function meanPerBin(features: Float32Array, bin: number): number {
  let sum = 0;
  for (let t = 0; t < 800; t++) sum += features[bin * 800 + t];
  return sum / 800;
}

describe("melSpectrogram", () => {
  it("always returns exactly 80*800 values, regardless of input length", () => {
    for (const len of [0, 1, 100, 16000, N_SAMPLES_8S, N_SAMPLES_8S + 50000]) {
      const input = new Float32Array(len);
      expect(melSpectrogram(input).length).toBe(80 * 800);
    }
  });

  it("maps silence to a constant, finite floor value everywhere", () => {
    const silence = new Float32Array(N_SAMPLES_8S); // all zeros
    const features = melSpectrogram(silence);
    // Derived analytically (see task-6-report.md): an all-zero waveform stays all-zero after
    // zero-mean/unit-variance normalization (mean=0, so numerator is 0 regardless of the
    // denominator), so every frame's power spectrum is exactly 0, every mel-filter sum is 0,
    // every value gets clamped to MEL_FLOOR=1e-10, log10(1e-10) = -10 everywhere (so max=-10,
    // the max-8.0 floor never binds), and (-10+4)/4 = -1.5 everywhere.
    expect(features.length).toBe(80 * 800);
    for (let i = 0; i < features.length; i++) {
      expect(Number.isFinite(features[i])).toBe(true);
    }
    expect(features[0]).toBeCloseTo(-1.5, 4);
    for (let i = 1; i < features.length; i++) {
      expect(features[i]).toBeCloseTo(features[0], 4);
    }
  });

  it("puts more energy near 440 Hz than above 4 kHz for a 440 Hz sine", () => {
    const sine = new Float32Array(N_SAMPLES_8S);
    for (let i = 0; i < sine.length; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    const features = melSpectrogram(sine);
    expect(features.length).toBe(80 * 800);
    for (let i = 0; i < features.length; i++) expect(Number.isFinite(features[i])).toBe(true);

    const bins = Array.from({ length: 80 }, (_, b) => b);
    const near440 = [...bins].sort((a, b) => Math.abs(melBinCenterHz(a) - 440) - Math.abs(melBinCenterHz(b) - 440)).slice(0, 3);
    const above4k = bins.filter((b) => melBinCenterHz(b) > 4000);
    expect(above4k.length).toBeGreaterThan(0);

    const nearEnergy = Math.max(...near440.map((b) => meanPerBin(features, b)));
    const highEnergy = Math.max(...above4k.map((b) => meanPerBin(features, b)));
    expect(nearEnergy).toBeGreaterThan(highEnergy);
  });

  it("produces only finite values for random noise", () => {
    const noise = new Float32Array(N_SAMPLES_8S);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
    const features = melSpectrogram(noise);
    expect(features.length).toBe(80 * 800);
    for (let i = 0; i < features.length; i++) {
      expect(Number.isFinite(features[i])).toBe(true);
    }
  });
});
