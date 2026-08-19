import { readFileSync, writeFileSync } from "node:fs";

export function writeWavPcm16Mono(path: string, sampleRate: number, pcm: Int16Array): void {
  const dataLen = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  writeFileSync(path, buf);
}

export function readWavPcm16Mono(path: string): { sampleRate: number; pcm: Int16Array } {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error(`not a RIFF/WAVE file: ${path}`);
  let off = 12, sampleRate = 0, dataStart = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      const fmt = buf.readUInt16LE(off + 8);
      const ch = buf.readUInt16LE(off + 10);
      const bits = buf.readUInt16LE(off + 22);
      sampleRate = buf.readUInt32LE(off + 12);
      if (fmt !== 1 || ch !== 1 || bits !== 16)
        throw new Error(`expected PCM16 mono, got fmt=${fmt} ch=${ch} bits=${bits}: ${path}`);
    } else if (id === "data") { dataStart = off + 8; dataLen = size; }
    off += 8 + size + (size % 2);
  }
  if (sampleRate === 0 || dataStart < 0) throw new Error(`missing fmt/data chunk: ${path}`);
  const pcm = new Int16Array(dataLen / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(dataStart + i * 2);
  return { sampleRate, pcm };
}

export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}
export function concatInt16(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
export function silence(sampleRate: number, seconds: number): Int16Array {
  return new Int16Array(Math.round(sampleRate * seconds));
}
