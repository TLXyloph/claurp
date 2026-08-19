import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readWavPcm16Mono } from "../../src/audio/pcm.js";
import { modelPath } from "../../src/paths.js";
import { createWhisperTranscriber, type Transcriber } from "../../src/audio/transcriber.js";

const FIX = join(import.meta.dirname, "..", "fixtures");
const haveModel = existsSync(modelPath("ggml-base.en.bin"));

describe.skipIf(!haveModel)("whisper transcriber", () => {
  let t: Transcriber;
  beforeAll(async () => {
    t = createWhisperTranscriber();
    await t.start();
  });
  afterAll(async () => { await t.stop(); });

  it("transcribes the create-file fixture", async () => {
    const { pcm } = readWavPcm16Mono(join(FIX, "hey_claude_create_file.wav"));
    const text = (await t.transcribe(pcm)).toLowerCase();
    expect(text).toContain("claude");
    // whisper mis-transcribes the trailing "haiku" nondeterministically (~40% of runs
    // produce "hyper inid"/"hiker"/etc. instead), so we anchor on "file" and "notes",
    // reliably-transcribed mid-utterance tokens (25/25 in a 25-run characterization).
    expect(text).toContain("file");
    expect(text).toContain("notes");
  });

  it("returns empty-ish text for silence", async () => {
    const { pcm } = readWavPcm16Mono(join(FIX, "silence_2s.wav"));
    const text = (await t.transcribe(pcm)).trim();
    expect(text.length).toBeLessThan(20); // whisper sometimes emits "[BLANK_AUDIO]"-ish noise
  });
});
