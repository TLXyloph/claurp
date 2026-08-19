// sherpa-onnx-node ships no TypeScript declarations (see node_modules/sherpa-onnx-node/README.md,
// which points to https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md
// for usage). This declares only the surface this package actually uses, verified against the
// installed package's JSDoc in node_modules/sherpa-onnx-node/types.js, vad.js, keyword-spotter.js
// and streaming-asr.js. Extend this single `declare module` block in place for future surfaces
// (e.g. streaming ASR) rather than adding a second declaration file or redeclaring the module.
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

  // --- KeywordSpotter surface, verified against the installed package's
  // JSDoc in types.js / keyword-spotter.js / streaming-asr.js. ---

  export interface OfflineTransducerModelConfig {
    encoder?: string;
    decoder?: string;
    joiner?: string;
  }

  export interface FeatureConfig {
    sampleRate?: number;
    featureDim?: number;
  }

  export interface OfflineModelConfig {
    transducer?: OfflineTransducerModelConfig;
    tokens?: string;
    numThreads?: number;
    debug?: boolean | number;
    provider?: string;
  }

  export interface KeywordSpotterConfig {
    featConfig?: FeatureConfig;
    modelConfig?: OfflineModelConfig;
    maxActivePaths?: number;
    numTrailingBlanks?: number;
    keywordsScore?: number;
    keywordsThreshold?: number;
    keywordsFile?: string;
  }

  export interface KeywordResult {
    start_time: number;
    keyword: string;
    timestamps: number[];
    tokens: string[];
  }

  /** Returned by KeywordSpotter#createStream(); same underlying class the vendor uses for streaming ASR. */
  export interface OnlineStream {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
  }

  export class KeywordSpotter {
    constructor(config: KeywordSpotterConfig);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): KeywordResult;
  }

  const sherpaOnnxNode: { Vad: typeof Vad; KeywordSpotter: typeof KeywordSpotter };
  export default sherpaOnnxNode;
}
