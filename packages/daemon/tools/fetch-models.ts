import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { modelPath } from "../src/paths.js";

type ModelSpec = { id: string; url: string; dest: string; extract?: "tar.bz2" };

export const MODELS: ModelSpec[] = [
  {
    id: "silero-vad",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    dest: modelPath("silero_vad.onnx"),
  },
  {
    id: "kws-zipformer",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2",
    dest: modelPath("kws-zipformer.tar.bz2"),
    extract: "tar.bz2",
  },
  {
    id: "smart-turn-v3",
    url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.0.onnx",
    dest: modelPath("smart-turn-v3.onnx"),
  },
  {
    id: "whisper-base-en",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    dest: modelPath("ggml-base.en.bin"),
  },
];

async function fetchOne(m: ModelSpec): Promise<void> {
  if (existsSync(m.extract ? m.dest.replace(/\.tar\.bz2$/, "") : m.dest)) {
    console.log(`✓ ${m.id} present`);
    return;
  }
  console.log(`↓ ${m.id} ← ${m.url}`);
  const res = await fetch(m.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${m.id}: HTTP ${res.status} — if 404, check the filename against the release/HF page and fix MODELS`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(m.dest), { recursive: true });
  writeFileSync(m.dest, buf);
  console.log(`  sha256=${createHash("sha256").update(buf).digest("hex")} (record in models/RECIPE.md)`);
  if (m.extract === "tar.bz2") {
    execFileSync("tar", ["xjf", m.dest, "-C", dirname(m.dest)]);
    console.log(`  extracted next to ${m.dest}`);
  }
}

for (const m of MODELS) await fetchOne(m);
console.log("done.");
