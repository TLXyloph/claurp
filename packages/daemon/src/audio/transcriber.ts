import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWavPcm16Mono } from "./pcm.js";
import { modelPath } from "../paths.js";

export interface Transcriber {
  start(): Promise<void>;
  transcribe(pcm16k: Int16Array): Promise<string>;
  stop(): Promise<void>;
}

export function createWhisperTranscriber(
  opts: { modelFile?: string; port?: number } = {},
): Transcriber {
  const model = opts.modelFile ?? modelPath("ggml-base.en.bin");
  const port = opts.port ?? 17771;
  let child: ChildProcess | null = null;
  const tmp = mkdtempSync(join(tmpdir(), "claurp-stt-"));

  async function healthy(): Promise<boolean> {
    try {
      // Verified live against the installed whisper-server (v1.9.2): it exposes a
      // dedicated GET /health -> 200 {"status":"ok"}, a more purpose-built readiness
      // check than polling "/" (which only serves the demo HTML page).
      const r = await fetch(`http://127.0.0.1:${port}/health`, { method: "GET" });
      return r.status < 500;
    } catch {
      return false;
    }
  }

  return {
    async start(): Promise<void> {
      child = spawn("whisper-server", ["-m", model, "--host", "127.0.0.1", "--port", String(port)], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      child.on("exit", (code) => {
        if (code !== null && code !== 0) console.error(`whisper-server exited ${code}`);
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await healthy()) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("whisper-server did not become healthy in 30s (is `brew install whisper-cpp` done?)");
    },

    async transcribe(pcm16k: Int16Array): Promise<string> {
      const wav = join(tmp, `u-${Date.now()}.wav`);
      writeWavPcm16Mono(wav, 16000, pcm16k);
      const form = new FormData();
      form.append("file", new Blob([readFileSync(wav)]), "u.wav");
      form.append("response_format", "json");
      // Verified live: whisper-server's decode defaults (best_of=2, beam_size=-1 i.e.
      // greedy) measurably mis-transcribe short command phrases — e.g. "...with a haiku
      // in it" came back as "...with a High Coup in it" on the create-file fixture at
      // defaults. `beam_size`/`best_of` aren't in `whisper-server --help` (that only
      // documents server-startup flags); they're per-request multipart fields, confirmed
      // real via `strings` on the binary and functionally confirmed live (3x repeated,
      // deterministic) — requesting beam search this way fixed the mis-transcription with
      // no server-side flag changes needed.
      form.append("beam_size", "5");
      form.append("best_of", "5");
      const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`whisper inference HTTP ${res.status}`);
      const json = (await res.json()) as { text?: string };
      return (json.text ?? "").trim();
    },

    async stop(): Promise<void> {
      child?.kill("SIGTERM");
      child = null;
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
