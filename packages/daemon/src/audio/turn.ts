// smart-turn v3 ONNX. Discovered I/O (Task 6 Step 1 — full detail in task-6-report.md):
//   input:  "input_features"  float32  [batch_size, 80, 800]
//   output: "logits"          float32  [batch_size, 1]
// `input_features` is a Whisper-style log-mel spectrogram of the trailing 8s @ 16kHz — NOT
// raw PCM, despite the brief's original sketch assuming a raw-audio input (that assumption
// was a plan defect, confirmed by a live onnxruntime-node error: "Invalid rank for input:
// input_features Got: 2 Expected: 3"). See mel.ts for the feature extraction, ported from the
// canonical reference found during Step 1 discovery.
//
// Despite the output tensor being named "logits", an empirical range test (feeding synthetic
// input_features of all-zeros / uniform noise in [-1,1] / uniform noise in [-50,50]) showed
// the value stays tightly bounded in (0,1) for all three (0.977 / 0.967 / 0.945 respectively)
// — even wildly out-of-distribution input never left [0,1], which a raw (un-squashed) logit
// layer would not guarantee. This matches the upstream Python reference
// (pipecat-ai/smart-turn's inference.py): "Extract probability (ONNX model returns sigmoid
// probabilities)" — used directly as `probability` with no extra sigmoid call. So the ONNX
// graph already applies sigmoid; the defensive fallback below (squash only if outside [0,1])
// is kept as a safety net per the brief's sketch but should not trigger in practice.
import * as ort from "onnxruntime-node";
import { melSpectrogram } from "./mel.js";
import { modelPath } from "../paths.js";

export interface TurnDetector {
  isComplete(pcm16k: Float32Array): Promise<boolean>;
}

const WINDOW = 8 * 16000;

// Trailing-silence trim (Task 6 amended-scope investigation, full matrix in task-6-report.md).
// The frozen fixture's full-vs-cut probabilities didn't separate at all with correct
// preprocessing and the (then-default) `say` voice: full=0.041, cut=0.517 -- inverted. An
// empirical sweep of 5 voice engines (incl. kokoro-js) x 3 trailing-silence handling settings
// found this was a real-speech-realism problem, not a preprocessing bug (independently
// verified bit-identical against a Python ground-truth run of the same mel-feature reference).
// Winning combination: `say -v Karen` (tools/make-fixtures.ts) + trimming the fed window's
// trailing near-silence down to at most 200ms before the 8s window is built, which matches how
// pipecat's own production analyzer behaves in practice (it feeds audio ending near the pause
// onset, not with a long fixed silence tail baked in). "Sub-energy" = any 20ms frame whose peak
// amplitude is below 2% of the whole clip's peak amplitude -- a simple, dependency-free trim,
// not a full VAD; scan backward from the end to find the last frame above that floor, then keep
// at most TRIM_TAIL_MS beyond it.
const TRIM_TAIL_MS = 200;
const TRIM_FRAME_MS = 20;
const TRIM_ENERGY_RATIO = 0.02;

function trimTrailingSilence(pcm: Float32Array, maxTailMs: number, sampleRate = 16000): Float32Array {
  const maxTailSamples = Math.round((maxTailMs / 1000) * sampleRate);
  const frameSize = Math.round((TRIM_FRAME_MS / 1000) * sampleRate);
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
  }
  const threshold = peak * TRIM_ENERGY_RATIO;
  let lastVoicedEnd = 0;
  for (let start = pcm.length - frameSize; start >= 0; start -= frameSize) {
    let frameMax = 0;
    const end = Math.min(start + frameSize, pcm.length);
    for (let i = start; i < end; i++) {
      const a = Math.abs(pcm[i]);
      if (a > frameMax) frameMax = a;
    }
    if (frameMax > threshold) {
      lastVoicedEnd = end;
      break;
    }
  }
  return pcm.subarray(0, Math.min(pcm.length, lastVoicedEnd + maxTailSamples));
}

// Threshold: left at the brief's default 0.5 (allowed tuning range 0.4-0.6). Observed
// probabilities on the real (Karen-voiced) hey_claude_create_file.wav fixture, with the
// trailing-silence trim above applied: full=0.6616, cut(55%)=0.0236 -- comfortably separated
// on either side of 0.5 (and of the whole 0.4-0.6 window), confirmed stable across 3 independent
// fresh re-syntheses (bit-identical each time). See task-6-report.md for the full matrix.
export async function createSmartTurn(opts: { threshold?: number } = {}): Promise<TurnDetector> {
  const threshold = opts.threshold ?? 0.5;
  const session = await ort.InferenceSession.create(modelPath("smart-turn-v3.onnx"));
  const inputName = session.inputNames[0]; // "input_features"
  const outputName = session.outputNames[0]; // "logits"
  return {
    async isComplete(pcm16k: Float32Array): Promise<boolean> {
      const trimmed = trimTrailingSilence(pcm16k, TRIM_TAIL_MS);
      const window = new Float32Array(WINDOW); // zero-padded head
      const tail = trimmed.slice(Math.max(0, trimmed.length - WINDOW));
      window.set(tail, WINDOW - tail.length);
      const features = melSpectrogram(window);
      const feeds: Record<string, ort.Tensor> = {
        [inputName]: new ort.Tensor("float32", features, [1, 80, 800]),
      };
      const out = await session.run(feeds);
      const data = out[outputName].data as Float32Array;
      // single logit/probability; if the model emits a logit, squash it (see header comment —
      // empirically the model already emits a probability, so this branch is a safety net)
      const v = data[0];
      const p = v >= 0 && v <= 1 ? v : 1 / (1 + Math.exp(-v));
      return p > threshold;
    },
  };
}
