import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sherpa from "sherpa-onnx-node";
import { modelPath } from "../paths.js";

export interface WakeSpotter {
  feed(frame: Float32Array): string | null;
  reset(): void;
}

const KWS_DIR = modelPath("sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01");

// The KWS dir ships both full-precision and `.int8.onnx` quantized variants of each
// encoder/decoder/joiner. A plain `.find(startsWith && endsWith(".onnx"))` would pick
// whichever sorts first in `readdirSync` output (on this filesystem that's the int8
// variant, since ".int8.onnx" < ".onnx" lexically) — an accidental, filesystem-order-
// dependent model choice. Filter out the int8 files and sort so the full-precision
// model is always selected deterministically, regardless of directory listing order.
function file(prefix: string): string {
  const hit = readdirSync(KWS_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".onnx") && !f.endsWith(".int8.onnx"))
    .sort()[0];
  if (!hit) throw new Error(`no ${prefix}*.onnx (non-int8) in ${KWS_DIR}`);
  return join(KWS_DIR, hit);
}

export async function createWakeSpotter(opts: { keywordsFile?: string } = {}): Promise<WakeSpotter> {
  const keywordsFile =
    opts.keywordsFile ?? join(import.meta.dirname, "..", "..", "..", "..", "models", "keywords-hey-claude.txt");
  if (!existsSync(keywordsFile)) throw new Error(`missing keywords file: ${keywordsFile}`);
  const kws = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: file("encoder"), decoder: file("decoder"), joiner: file("joiner") },
      tokens: join(KWS_DIR, "tokens.txt"),
      provider: "cpu",
      numThreads: 1,
      debug: false,
    },
    keywordsFile,
    keywordsScore: 2.0,
    // 0.25 -> 0.2 (Task 6 amended-scope fixture-voice change): regenerating the fixtures with
    // `say -v Karen` (tools/make-fixtures.ts, see turn.ts/task-6-report.md for why) made the
    // standalone "hey claude" fixture (hey_claude.wav, no trailing sentence) just miss the
    // 0.25 threshold. Swept score in {2.0..3.0} x threshold in {0.25,0.2,0.15} (the sanctioned
    // tuning window) against all four wake fixtures; threshold=0.2 at the original score=2.0
    // was the first passing combination, so score was left untouched. Still within the
    // sanctioned floor of >=0.15.
    keywordsThreshold: 0.2,
  });
  let stream = kws.createStream();
  return {
    feed(frame: Float32Array): string | null {
      stream.acceptWaveform({ sampleRate: 16000, samples: frame });
      while (kws.isReady(stream)) kws.decode(stream);
      const r = kws.getResult(stream);
      if (r && r.keyword && r.keyword.length > 0) {
        kws.reset(stream);
        return r.keyword;
      }
      return null;
    },
    reset(): void {
      stream = kws.createStream();
    },
  };
}
