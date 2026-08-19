import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { concatInt16, readWavPcm16Mono, silence, writeWavPcm16Mono } from "../src/audio/pcm.js";

const FIX = join(import.meta.dirname, "..", "test", "fixtures");
mkdirSync(FIX, { recursive: true });

function synth(name: string, text: string): void {
  const raw = join(FIX, `_raw_${name}`);
  execFileSync("say", ["-o", raw, "--data-format=LEI16@16000", "--file-format=WAVE", text]);
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
