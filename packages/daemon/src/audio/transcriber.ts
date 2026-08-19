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
  let seq = 0;
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
      const c = spawn("whisper-server", ["-m", model, "--host", "127.0.0.1", "--port", String(port)], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      child = c;
      c.on("exit", (code) => {
        if (code !== null && code !== 0) console.error(`whisper-server exited ${code}`);
      });
      // A listener is required here regardless of the race below: an unhandled 'error'
      // event on a ChildProcess (e.g. ENOENT when the binary isn't on PATH) otherwise
      // throws and crashes the process. Wiring it into a promise also lets a failed
      // launch reject start() promptly instead of silently waiting out the 30s poll.
      const launchFailed = new Promise<never>((_resolve, reject) => {
        c.on("error", (err) => {
          reject(
            new Error(`whisper-server failed to launch: ${err.message} (is \`brew install whisper-cpp\` done?)`),
          );
        });
      });
      const pollHealthy = (async (): Promise<void> => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (await healthy()) return;
          await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error("whisper-server did not become healthy in 30s (is `brew install whisper-cpp` done?)");
      })();
      try {
        await Promise.race([pollHealthy, launchFailed]);
      } catch (err) {
        // Either failure mode (timeout or failed launch) can leave a child holding the
        // port/model — make sure neither orphans one.
        child?.kill("SIGTERM");
        child = null;
        throw err;
      }
    },

    async transcribe(pcm16k: Int16Array): Promise<string> {
      // Date.now() alone can collide within the same millisecond under rapid calls; the
      // seq suffix guarantees uniqueness regardless of timing.
      const wav = join(tmp, `u-${Date.now()}-${seq++}.wav`);
      writeWavPcm16Mono(wav, 16000, pcm16k);
      try {
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
      } finally {
        // Per-call cleanup so temp WAVs don't accumulate across a long-lived session;
        // stop()'s mkdtemp removal below is only the backstop for whatever this misses.
        rmSync(wav, { force: true });
      }
    },

    async stop(): Promise<void> {
      child?.kill("SIGTERM");
      child = null;
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
