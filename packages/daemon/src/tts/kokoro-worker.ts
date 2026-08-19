// Child-process worker for Kokoro TTS.
//
// WHY A SEPARATE PROCESS: kokoro-js bundles its own onnxruntime-node native addon.
// The daemon's main process already loads a *different* onnxruntime-node session
// (VAD/wake/turn-detector) — Task 6 found empirically that loading both in one
// process crashes with `std::bad_alloc` / `mutex lock failed`. So this worker runs
// kokoro-js in total isolation; kokoro.ts (the parent) only ever talks to it over
// Node's IPC channel, never imports kokoro-js itself.
//
// Message protocol (Node child_process IPC, `serialization: "advanced"` so
// Int16Array chunks travel as real typed arrays, not JSON):
//   parent -> worker: { type: "synthesize", id, text, voice } | { type: "abort", id }
//   worker -> parent: { type: "ready" } | { type: "fatal", message }
//                    | { type: "chunk", id, pcm: Int16Array }
//                    | { type: "done", id } | { type: "error", id, message }
//
// This worker never writes to stdout: @huggingface/transformers (kokoro-js's
// backend) calls plain `console.log` in several places (confirmed by inspecting
// its bundled dist — e.g. a default progress-callback fallback that logs during
// model download), which would have corrupted a raw length-prefixed-stdout
// protocol. Using the IPC channel instead of stdio framing sidesteps that
// entirely, at the cost of deviating from the literal "PCM over stdio" phrasing
// suggested upstream — documented here and in the task report.
import { join } from "node:path";
import { claurpHome } from "../paths.js";

// Must be set before kokoro-js (and the @huggingface/transformers it re-exports)
// ever fetches the model — kokoro-js's own re-exported `env` does NOT have a
// `cacheDir` property (confirmed empirically in Task 6); only the real
// `@huggingface/transformers` `env` singleton does. HF_HOME is a no-op here (it's
// a Python-`transformers` convention, not read by this JS package).
const transformers = await import("@huggingface/transformers");
transformers.env.cacheDir = join(claurpHome(), "models", "hf");

// Imported dynamically, after cacheDir is set, so the model fetch inside
// from_pretrained() below sees the redirected cache dir.
const { KokoroTTS } = await import("kokoro-js");

const CHUNK_SAMPLES = 4800; // ~200ms @ 24kHz

type ParentMessage = { type: "synthesize"; id: number; text: string; voice: string } | { type: "abort"; id: number };

const abortedIds = new Set<number>();

function floatToInt16(audio: Float32Array): Int16Array {
  const out = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const clamped = Math.max(-1, Math.min(1, audio[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

async function main(): Promise<void> {
  let tts: InstanceType<typeof KokoroTTS>;
  try {
    tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8" });
  } catch (err) {
    process.send?.({ type: "fatal", message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
    return;
  }
  process.send?.({ type: "ready" });

  process.on("message", (raw: ParentMessage) => {
    if (raw.type === "abort") {
      abortedIds.add(raw.id);
      return;
    }
    void handleSynthesize(tts, raw.id, raw.text, raw.voice);
  });
}

async function handleSynthesize(tts: InstanceType<typeof KokoroTTS>, id: number, text: string, voice: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { audio, sampling_rate } = await tts.generate(text, { voice: voice as any });
    if (sampling_rate !== 24000) {
      throw new Error(`kokoro returned unexpected sample rate ${sampling_rate}, expected 24000`);
    }
    const pcm = floatToInt16(audio);
    let aborted = false;
    for (let offset = 0; offset < pcm.length; offset += CHUNK_SAMPLES) {
      if (abortedIds.has(id)) {
        aborted = true;
        break;
      }
      const chunk = pcm.slice(offset, offset + CHUNK_SAMPLES); // .slice(): independent buffer, not a shared view
      process.send?.({ type: "chunk", id, pcm: chunk });
      // Yield to the event loop between sends. `generate()` returns the whole
      // utterance at once, so without this, the loop below never gives Node a
      // chance to deliver an in-flight "abort" IPC message — it's I/O-driven
      // and can't be processed mid-synchronous-callback. This is the literal
      // "check an aborted flag between slices for stop()" from the brief.
      await new Promise((resolve) => setImmediate(resolve));
    }
    abortedIds.delete(id);
    if (!aborted) process.send?.({ type: "done", id });
  } catch (err) {
    abortedIds.delete(id);
    process.send?.({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  }
}

void main();
