import { describe, expect, it } from "vitest";
import { TRIM_TAIL_MS, trimTrailingSilence } from "../../src/audio/turn.js";

// Pure DSP, no ONNX model needed -- unlike turn.test.ts this never needs describe.skipIf.
const SAMPLE_RATE = 16000;
const TAIL_BUDGET_SAMPLES = Math.round((TRIM_TAIL_MS / 1000) * SAMPLE_RATE); // 3200 @ 200ms/16kHz
const WINDOW_SAMPLES = 8 * SAMPLE_RATE; // mirrors turn.ts's WINDOW (the peak-reference scope)

describe("trimTrailingSilence", () => {
  it("caps an all-silence input at the tail budget", () => {
    const silence = new Float32Array(SAMPLE_RATE); // 1s of true silence
    const result = trimTrailingSilence(silence, TRIM_TAIL_MS);
    expect(result.length).toBe(TAIL_BUDGET_SAMPLES);
  });

  it("keeps loud audio unchanged when there is no trailing silence", () => {
    const loud = new Float32Array(8000); // 0.5s
    loud.fill(0.8);
    const result = trimTrailingSilence(loud, TRIM_TAIL_MS);
    expect(result.length).toBe(loud.length);
    expect(Array.from(result)).toEqual(Array.from(loud));
  });

  it("does not crash on input shorter than one analysis frame, or on empty input", () => {
    const tiny = new Float32Array(100); // shorter than the 20ms/320-sample analysis frame
    tiny.fill(0.5);
    const resultTiny = trimTrailingSilence(tiny, TRIM_TAIL_MS);
    // No full frame exists to classify as voiced or silent, so lastVoicedEnd stays at 0 and the
    // result is just capped at min(length, tail budget) -- here the whole (very short) input.
    expect(resultTiny.length).toBe(100);

    const empty = new Float32Array(0);
    expect(trimTrailingSilence(empty, TRIM_TAIL_MS).length).toBe(0);
  });

  it("does not trim when trailing near-silence exactly equals the tail budget", () => {
    const loudLen = 1000;
    const pcm = new Float32Array(loudLen + TAIL_BUDGET_SAMPLES);
    pcm.fill(1.0, 0, loudLen); // loud head; the rest stays 0 (Float32Array default) -- exactly
    // TRIM_TAIL_MS of true silence at the tail, right at the boundary.
    const result = trimTrailingSilence(pcm, TRIM_TAIL_MS);
    expect(result.length).toBe(pcm.length); // at-budget tail is kept whole, not trimmed
  });

  it("trims when trailing near-silence exceeds the tail budget", () => {
    const loudLen = 1000;
    const extraSilence = TAIL_BUDGET_SAMPLES; // another 200ms beyond the budget
    const pcm = new Float32Array(loudLen + TAIL_BUDGET_SAMPLES + extraSilence);
    pcm.fill(1.0, 0, loudLen);
    const result = trimTrailingSilence(pcm, TRIM_TAIL_MS);
    expect(result.length).toBe(loudLen + TAIL_BUDGET_SAMPLES); // trimmed to loud + exactly the budget
  });

  it("does not trim away quiet-but-voiced recent audio after a loud earlier moment (regression: clip-global peak)", () => {
    // Reproduces the bug: an unbounded "utterance so far" with a loud moment well before the
    // trailing 8s window, followed by a long, genuinely-voiced-but-quiet tail with NO trailing
    // silence at all. A peak computed over the whole clip (the pre-fix behavior) would set a
    // threshold the quiet tail falls under, so the backward scan would misread the entire quiet
    // tail as "sub-energy" and the trim would discard almost all of it. With the peak correctly
    // scoped to only the trailing WINDOW, the quiet tail's own (lower) peak sets the threshold,
    // the tail correctly reads as voiced throughout, and nothing gets trimmed.
    const headLen = 1000;
    const tailLen = WINDOW_SAMPLES + 2000; // long enough that the loud head falls outside the
    // trailing WINDOW once combined with headLen (headLen + tailLen - WINDOW_SAMPLES > headLen).
    const pcm = new Float32Array(headLen + tailLen);
    pcm.fill(1.0, 0, headLen); // loud early moment, well outside the trailing 8s
    pcm.fill(0.01, headLen, pcm.length); // quiet (1% of the head's amplitude) but voiced, right
    // up to the very end -- no trailing silence in the tail at all.
    const result = trimTrailingSilence(pcm, TRIM_TAIL_MS);
    expect(result.length).toBe(pcm.length); // the quiet tail must survive completely untrimmed
  });
});
