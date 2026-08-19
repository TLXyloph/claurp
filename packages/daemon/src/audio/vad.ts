import sherpa from "sherpa-onnx-node";
import { modelPath } from "../paths.js";

export interface VadGate {
  isSpeech(frame: Float32Array): boolean; // 512 samples @ 16 kHz
  reset(): void;
}

export async function createSileroVad(opts: { threshold?: number } = {}): Promise<VadGate> {
  const config = {
    sileroVad: {
      model: modelPath("silero_vad.onnx"),
      threshold: opts.threshold ?? 0.5,
      minSilenceDuration: 0.25,
      minSpeechDuration: 0.1,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: 1,
    debug: false,
  };
  const vad = new sherpa.Vad(config, 30 /* buffer seconds */);
  return {
    isSpeech(frame: Float32Array): boolean {
      vad.acceptWaveform(frame);
      return vad.isDetected();
    },
    reset(): void {
      // clear() drops any queued detected segments; reset() puts the underlying
      // model's triggered/hidden state back to fresh — both are needed for a full reset.
      vad.clear();
      vad.reset();
    },
  };
}
