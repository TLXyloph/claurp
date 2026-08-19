// sherpa-onnx-node ships no TypeScript declarations (see node_modules/sherpa-onnx-node/README.md,
// which points to https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md
// for usage). This declares only the surface this package actually uses, verified against the
// installed package's JSDoc in node_modules/sherpa-onnx-node/types.js and vad.js.
declare module "sherpa-onnx-node" {
  export interface SileroVadModelConfig {
    model?: string;
    threshold?: number;
    minSilenceDuration?: number;
    minSpeechDuration?: number;
    windowSize?: number;
    maxSpeechDuration?: number;
  }

  export interface VadConfig {
    sileroVad?: SileroVadModelConfig;
    sampleRate?: number;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    /** Clears the internal queue of already-detected speech segments. */
    clear(): void;
    /** Resets the underlying VAD model's internal state (e.g. triggered/hidden state). */
    reset(): void;
    flush(): void;
  }

  const sherpaOnnxNode: { Vad: typeof Vad };
  export default sherpaOnnxNode;
}
