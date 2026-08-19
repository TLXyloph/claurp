import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { concatInt16, readWavPcm16Mono, silence, writeWavPcm16Mono } from "../src/audio/pcm.js";

const FIX = join(import.meta.dirname, "..", "test", "fixtures");
mkdirSync(FIX, { recursive: true });

// Voice: macOS `say -v Karen` (en_AU). Chosen empirically (Task 6 amended-scope investigation,
// see task-6-report.md) over the previous unspecified system-default voice: an empirical
// engine x trailing-silence-trim matrix (5 voice engines incl. kokoro-js, x 3 trim settings)
// against the real smart-turn-v3 model found the default `say` voice's flat, TTS-typical
// prosody didn't separate a complete vs. mid-word-cut utterance at all (full=0.041, cut=0.517
// -- inverted), consistent with smart-turn-v3.0's own release notes flagging heavy synthetic-
// TTS training data as a known weakness class. Karen was the first engine (in the matrix's
// tested order) that, combined with turn.ts's trailing-silence trim, gave a comfortable and
// perfectly stable (3/3 identical runs) separation: full=0.6616, cut=0.0236.
function synth(name: string, text: string): void {
  const raw = join(FIX, `_raw_${name}`);
  execFileSync("say", ["-v", "Karen", "-o", raw, "--data-format=LEI16@16000", "--file-format=WAVE", text]);
  const { pcm } = readWavPcm16Mono(raw);
  const padded = concatInt16([silence(16000, 0.3), pcm, silence(16000, 0.8)]);
  writeWavPcm16Mono(join(FIX, name), 16000, padded);
}

synth("hey_claude.wav", "hey claude");
synth("hey_claude_status.wav", "hey claude, status");
synth("hey_claude_create_file.wav", "hey claude, create a file called notes dot text with a haiku in it");
synth("allow.wav", "allow");
synth("plain_speech.wav", "the quick brown fox jumps over the lazy dog");
writeWavPcm16Mono(join(FIX, "silence_2s.wav"), 16000, silence(16000, 2));
console.log("fixtures written to", FIX);
