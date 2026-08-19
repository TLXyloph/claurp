# claurp v0.1 Core (Protocol + Daemon) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/protocol` and `packages/daemon` so a scripted WebSocket client (standing in for the Swift senses app) can drive the full loop: WAV fixture in → wake word → streaming transcript → intent routing → agent session (fake or real Claude Code) → permission-by-voice → narration text → TTS audio frames out.

**Architecture:** Two npm workspaces. `packages/protocol` holds zod schemas for every WS message, the binary frame format, and the `AgentAdapter`/`SessionHandle` contract — it is the spine both the daemon and the future Swift app compile against. `packages/daemon` wires an audio pipeline (VAD → KWS → STT → turn detection), a verb router, a session manager with pluggable agent adapters, a permission policy engine, a passive usage meter, a template narrator, and Kokoro TTS behind one WebSocket server.

**Tech Stack:** Node ≥ 20, TypeScript ^5.5, pnpm 9 workspaces, vitest ^2, zod ^3.23, ws ^8, sherpa-onnx-node ^1.12 (Silero VAD + open-vocab KWS), onnxruntime-node ^1.19 (smart-turn v3), whisper.cpp via Homebrew `whisper-server` child process, kokoro-js ^1 (TTS), `@anthropic-ai/claude-agent-sdk` (Claude Code adapter).

**Spec:** `docs/superpowers/specs/2026-08-18-claurp-design.md` — read §2 (principles), §3 (architecture), §4 (voice pipeline), §5 (sessions/adapters/permissions/meter), §7.2–7.3 (narrator/TTS) before starting. This plan implements the daemon half of spec §10 "v0.1"; the Swift helper and packaging are separate follow-up plans.

## Global Constraints

- **No Python anywhere in the product** (spec §3). Dev-time model prep may use documented one-off commands whose *output is committed*.
- **Raw audio never leaves the machine** (spec §2.2): no network calls in the audio pipeline; the only outbound traffic is what the user's own agent binary sends.
- **Files under 500 lines** (project CLAUDE.md). Split before you hit it.
- **Typed public interfaces** for everything exported from `packages/protocol` and every daemon module boundary.
- **TDD, London school**: write the failing test first; adapters/engines are built against interfaces so fakes drop in.
- **Spec naming is law**: event kinds are exactly `started | text-delta | tool-use | needs-permission | needs-input | usage-metadata | done | error`; permission modes exactly `default | acceptEdits | plan | bypassPermissions`.
- **Never auto-allow the hard deny-list** (spec §5.4) regardless of user policy: recursive deletes, force-pushes, history rewrites, credential/secret file reads.
- Conventional commits (`feat:`, `test:`, `chore:`); commit at the end of every task, and at any green intermediate step you like.
- Runtime assets (models, whisper binaries) live under `~/.claurp/` — never inside the repo; `models/` in the repo holds only recipes and committed small text assets (keyword files).
- macOS is the dev platform for this plan; the daemon itself must not import anything macOS-only.

## Plan-of-plans context

- **Plan 1 (this document):** protocol + daemon, testable headless.
- **Plan 2 (later):** `apps/senses-macos` Swift app against the frozen protocol.
- **Plan 3 (later):** `npx claurp` first-run setup, packaging, CI hardening, E2E.

## File structure (locked by this plan)

```
packages/protocol/src/messages.ts     WS envelope, handshake, UI/audio messages, binary framing
packages/protocol/src/adapter.ts      AgentEvent union, AgentAdapter/SessionHandle contract
packages/protocol/src/intents.ts      Intent union produced by the router
packages/protocol/src/index.ts        re-exports
packages/daemon/src/paths.ts          ~/.claurp asset locations
packages/daemon/src/audio/pcm.ts      PCM16 helpers, WAV read/write
packages/daemon/src/audio/vad.ts      SileroVad (sherpa-onnx)
packages/daemon/src/audio/wake.ts     WakeSpotter (sherpa-onnx KWS)
packages/daemon/src/audio/transcriber.ts  Transcriber iface + WhisperCppTranscriber
packages/daemon/src/audio/turn.ts     TurnDetector (smart-turn v3 via onnxruntime)
packages/daemon/src/audio/pipeline.ts AudioPipeline state machine
packages/daemon/src/router.ts         parseIntent()
packages/daemon/src/sessions/projects.ts  named-projects config
packages/daemon/src/sessions/manager.ts   SessionManager
packages/daemon/src/agents/fake.ts    FakeAgent adapter (tests + demo)
packages/daemon/src/agents/contract.ts    shared adapter contract-test suite
packages/daemon/src/agents/claude.ts  ClaudeAdapter (Agent SDK)
packages/daemon/src/policy.ts         PermissionPolicy engine
packages/daemon/src/meter.ts          MeterService
packages/daemon/src/narrator.ts       template narrator
packages/daemon/src/tts/sentences.ts  streaming sentence splitter
packages/daemon/src/tts/kokoro.ts     TtsEngine iface + KokoroTts
packages/daemon/src/server.ts         DaemonServer (WS orchestration)
packages/daemon/src/cli.ts            claurp-daemon entry
packages/daemon/tools/fetch-models.ts model/asset downloader (dev + first-run)
packages/daemon/tools/make-fixtures.ts fixture WAV generator (macOS `say`; output committed)
packages/daemon/test/…                mirrors src; fixtures in test/fixtures/
models/keywords-hey-claude.txt        committed KWS keyword asset (generated once)
models/RECIPE.md                      how assets were produced (part of Task 4)
```

---

### Task 1: Monorepo scaffold + protocol package (messages)

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.npmrc`
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/messages.ts`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/messages.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `PROTOCOL_VERSION = 1`; zod schemas + TS types `SensesHello, DaemonHelloAck, StateMsg, TranscriptPartial, TranscriptFinal, EarconMsg, HudPermissionMsg, HudSessionMsg, NotifyMsg, SpeakStopMsg, PermissionResponseMsg, PttMsg`; discriminated unions `SensesToDaemonMsg`, `DaemonToSensesMsg` with `parseSensesMsg(json: unknown)` / `parseDaemonMsg(json: unknown)`; binary framing constants `BIN_MIC_PCM16_16K = 0x01`, `BIN_TTS_PCM16_24K = 0x02` and helpers `encodeBinaryFrame(type: number, payload: Int16Array): Buffer`, `decodeBinaryFrame(buf: Buffer): { type: number; pcm: Int16Array }`.

- [ ] **Step 1: Scaffold the workspace**

`package.json` (root):

```json
{
  "name": "claurp",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`.npmrc`:

```
node-linker=hoisted
```

`packages/protocol/package.json`:

```json
{
  "name": "@claurp/protocol",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": { "typescript": "^5.5.4", "vitest": "^2.1.1" }
}
```

`packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Run: `pnpm install`
Expected: lockfile created, no errors.

- [ ] **Step 2: Write the failing test**

`packages/protocol/test/messages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BIN_MIC_PCM16_16K,
  BIN_TTS_PCM16_24K,
  decodeBinaryFrame,
  encodeBinaryFrame,
  parseDaemonMsg,
  parseSensesMsg,
  PROTOCOL_VERSION,
} from "../src/index.js";

describe("protocol messages", () => {
  it("round-trips a senses hello", () => {
    const msg = { v: PROTOCOL_VERSION, type: "hello", client: "senses-macos", protocol: PROTOCOL_VERSION };
    expect(parseSensesMsg(msg)).toEqual(msg);
  });

  it("rejects unknown message types", () => {
    expect(() => parseSensesMsg({ v: 1, type: "nope" })).toThrow();
  });

  it("rejects a mismatched protocol major in hello", () => {
    expect(() => parseSensesMsg({ v: 999, type: "hello", client: "x", protocol: 999 })).toThrow();
  });

  it("parses a daemon permission HUD message", () => {
    const msg = {
      v: PROTOCOL_VERSION,
      type: "hud.permission",
      sessionId: "s1",
      requestId: "r1",
      tool: "Bash",
      detail: "npm install",
      spoken: "Claude wants to run npm install — allow?",
    };
    expect(parseDaemonMsg(msg)).toEqual(msg);
  });

  it("parses a permission response from senses", () => {
    const msg = { v: PROTOCOL_VERSION, type: "permission.response", sessionId: "s1", requestId: "r1", decision: "allow" };
    expect(parseSensesMsg(msg)).toEqual(msg);
  });

  it("round-trips binary PCM frames", () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
    const buf = encodeBinaryFrame(BIN_MIC_PCM16_16K, pcm);
    const out = decodeBinaryFrame(buf);
    expect(out.type).toBe(BIN_MIC_PCM16_16K);
    expect(Array.from(out.pcm)).toEqual(Array.from(pcm));
    expect(BIN_TTS_PCM16_24K).not.toBe(BIN_MIC_PCM16_16K);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @claurp/protocol test`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 4: Implement messages.ts and index.ts**

`packages/protocol/src/messages.ts`:

```ts
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const base = z.object({ v: z.literal(PROTOCOL_VERSION) });

// ---- senses → daemon ----
export const SensesHello = base.extend({
  type: z.literal("hello"),
  client: z.string().min(1),
  protocol: z.literal(PROTOCOL_VERSION),
});
export const PttMsg = base.extend({
  type: z.literal("ptt"),
  action: z.enum(["down", "up"]),
});
export const PermissionResponseMsg = base.extend({
  type: z.literal("permission.response"),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  decision: z.enum(["allow", "deny", "always"]),
});

export const SensesToDaemon = z.discriminatedUnion("type", [
  SensesHello,
  PttMsg,
  PermissionResponseMsg,
]);
export type SensesToDaemonMsg = z.infer<typeof SensesToDaemon>;

// ---- daemon → senses ----
export const DaemonHelloAck = base.extend({
  type: z.literal("hello.ack"),
  daemonVersion: z.string(),
});
export const StateMsg = base.extend({
  type: z.literal("state"),
  mode: z.enum(["idle", "listening", "working", "needs-you", "disconnected"]),
});
export const TranscriptPartial = base.extend({
  type: z.literal("transcript.partial"),
  text: z.string(),
});
export const TranscriptFinal = base.extend({
  type: z.literal("transcript.final"),
  text: z.string(),
});
export const EarconMsg = base.extend({
  type: z.literal("earcon"),
  kind: z.enum(["wake-ack", "shutter", "permission-ask", "done"]),
});
export const HudSessionMsg = base.extend({
  type: z.literal("hud.session"),
  sessionId: z.string(),
  label: z.string(),
  state: z.enum(["spawning", "working", "needs-permission", "needs-input", "done", "failed", "handed-off"]),
  permissionMode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]),
  narration: z.string().optional(),
});
export const HudPermissionMsg = base.extend({
  type: z.literal("hud.permission"),
  sessionId: z.string(),
  requestId: z.string(),
  tool: z.string(),
  detail: z.string(),
  spoken: z.string(),
});
export const NotifyMsg = base.extend({
  type: z.literal("notify"),
  title: z.string(),
  body: z.string(),
  sessionId: z.string().optional(),
  requestId: z.string().optional(),
  actions: z.array(z.enum(["allow", "deny", "open-terminal"])).default([]),
});
export const SpeakStopMsg = base.extend({ type: z.literal("speak.stop") });

export const DaemonToSenses = z.discriminatedUnion("type", [
  DaemonHelloAck,
  StateMsg,
  TranscriptPartial,
  TranscriptFinal,
  EarconMsg,
  HudSessionMsg,
  HudPermissionMsg,
  NotifyMsg,
  SpeakStopMsg,
]);
export type DaemonToSensesMsg = z.infer<typeof DaemonToSenses>;

export function parseSensesMsg(json: unknown): SensesToDaemonMsg {
  return SensesToDaemon.parse(json);
}
export function parseDaemonMsg(json: unknown): DaemonToSensesMsg {
  return DaemonToSenses.parse(json);
}

// ---- binary frames: [1 byte type][little-endian PCM16 payload] ----
export const BIN_MIC_PCM16_16K = 0x01;
export const BIN_TTS_PCM16_24K = 0x02;

export function encodeBinaryFrame(type: number, payload: Int16Array): Buffer {
  const buf = Buffer.alloc(1 + payload.length * 2);
  buf.writeUInt8(type, 0);
  for (let i = 0; i < payload.length; i++) buf.writeInt16LE(payload[i], 1 + i * 2);
  return buf;
}

export function decodeBinaryFrame(buf: Buffer): { type: number; pcm: Int16Array } {
  if (buf.length < 1 || (buf.length - 1) % 2 !== 0) throw new Error("malformed binary frame");
  const type = buf.readUInt8(0);
  const pcm = new Int16Array((buf.length - 1) / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(1 + i * 2);
  return { type, pcm };
}
```

`packages/protocol/src/index.ts`:

```ts
export * from "./messages.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @claurp/protocol test`
Expected: 6 passing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(protocol): workspace scaffold + WS message schemas and binary framing"
```

---

### Task 2: Daemon package scaffold + PCM/WAV utilities + committed fixtures

**Files:**
- Create: `packages/daemon/package.json`, `packages/daemon/tsconfig.json`, `packages/daemon/vitest.config.ts`
- Create: `packages/daemon/src/paths.ts`, `packages/daemon/src/audio/pcm.ts`
- Create: `packages/daemon/tools/make-fixtures.ts`
- Test: `packages/daemon/test/audio/pcm.test.ts`
- Commit generated: `packages/daemon/test/fixtures/*.wav`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `claurpHome(): string` (default `~/.claurp`, override via env `CLAURP_HOME`); `modelPath(...parts: string[]): string`; `readWavPcm16Mono(path: string): { sampleRate: number; pcm: Int16Array }`; `writeWavPcm16Mono(path: string, sampleRate: number, pcm: Int16Array): void`; `int16ToFloat32(pcm: Int16Array): Float32Array`; `concatInt16(parts: Int16Array[]): Int16Array`; `silence(sampleRate: number, seconds: number): Int16Array`. Fixture files later tasks rely on (all 16 kHz mono PCM16 WAV): `hey_claude.wav`, `hey_claude_status.wav` ("hey claude — status"), `hey_claude_create_file.wav` ("hey claude, create a file called notes dot text with a haiku in it"), `allow.wav` ("allow"), `plain_speech.wav` (speech with no wake phrase), `silence_2s.wav`.

- [ ] **Step 1: Scaffold the daemon package**

`packages/daemon/package.json`:

```json
{
  "name": "@claurp/daemon",
  "version": "0.1.0",
  "type": "module",
  "bin": { "claurp-daemon": "dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "tsc -p tsconfig.json --noEmit",
    "fixtures": "tsx tools/make-fixtures.ts",
    "models": "tsx tools/fetch-models.ts"
  },
  "dependencies": {
    "@claurp/protocol": "workspace:*",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.1.1",
    "tsx": "^4.19.0",
    "@types/ws": "^8.5.12",
    "@types/node": "^20.14.0"
  }
}
```

`packages/daemon/tsconfig.json` mirrors protocol's (outDir `dist`, rootDir `src`, include `src`). `packages/daemon/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000 } });
```

Run: `pnpm install`
Expected: clean.

- [ ] **Step 2: Write the failing PCM test**

`packages/daemon/test/audio/pcm.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  concatInt16,
  int16ToFloat32,
  readWavPcm16Mono,
  silence,
  writeWavPcm16Mono,
} from "../../src/audio/pcm.js";

describe("pcm/wav utilities", () => {
  it("writes then reads a 16k mono wav losslessly", () => {
    const dir = mkdtempSync(join(tmpdir(), "claurp-"));
    const pcm = new Int16Array([0, 100, -100, 32767, -32768, 5]);
    const p = join(dir, "t.wav");
    writeWavPcm16Mono(p, 16000, pcm);
    const back = readWavPcm16Mono(p);
    expect(back.sampleRate).toBe(16000);
    expect(Array.from(back.pcm)).toEqual(Array.from(pcm));
  });

  it("converts int16 to float32 in [-1, 1]", () => {
    const f = int16ToFloat32(new Int16Array([0, 16384, -32768]));
    expect(f[0]).toBeCloseTo(0);
    expect(f[1]).toBeCloseTo(0.5, 2);
    expect(f[2]).toBeCloseTo(-1, 3);
  });

  it("concats and makes silence of the right length", () => {
    const s = silence(16000, 0.5);
    expect(s.length).toBe(8000);
    expect(concatInt16([s, s]).length).toBe(16000);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @claurp/daemon test -- pcm`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement paths.ts and pcm.ts**

`packages/daemon/src/paths.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export function claurpHome(): string {
  return process.env.CLAURP_HOME ?? join(homedir(), ".claurp");
}
export function modelPath(...parts: string[]): string {
  return join(claurpHome(), "models", ...parts);
}
```

`packages/daemon/src/audio/pcm.ts` — a minimal RIFF reader/writer (PCM16 mono only; validate `fmt` chunk: audioFormat 1, one channel, 16 bits; throw with a clear message on anything else):

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- pcm`
Expected: 3 passing.

- [ ] **Step 6: Generate and commit the fixtures (macOS)**

`packages/daemon/tools/make-fixtures.ts` — uses macOS `say` to synthesize speech at 16 kHz PCM16, then post-processes with the pcm utils (pad 300 ms silence head, 800 ms tail so VAD/turn have room):

```ts
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
```

Run: `pnpm --filter @claurp/daemon fixtures`, then delete the `_raw_*` intermediates, listen-check one file (`afplay packages/daemon/test/fixtures/hey_claude.wav`), and commit the `.wav` files (they are small; committed so CI and Linux machines never need `say`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(daemon): package scaffold, pcm/wav utilities, committed audio fixtures"
```

---
### Task 3: Model fetcher + Silero VAD wrapper

**Files:**
- Create: `packages/daemon/tools/fetch-models.ts`
- Create: `packages/daemon/src/audio/vad.ts`
- Test: `packages/daemon/test/audio/vad.test.ts`
- Modify: `packages/daemon/package.json` (add `sherpa-onnx-node` ^1.12.0 to dependencies)

**Interfaces:**
- Consumes: `readWavPcm16Mono`, `int16ToFloat32`, `modelPath` from Task 2.
- Produces: `interface VadGate { isSpeech(frame: Float32Array): boolean; reset(): void }` (frame = 512 samples @16 kHz) and `createSileroVad(opts?: { threshold?: number }): Promise<VadGate>`; `tools/fetch-models.ts` with a `MODELS` manifest and CLI `pnpm --filter @claurp/daemon models` that downloads everything missing into `~/.claurp/models/` (used by every later audio task).

**Vendor-API note (applies to Tasks 3, 4, 6):** wrapper interfaces and tests in this plan are frozen; the *call sites into vendor libraries* are best-current-knowledge. If the installed `sherpa-onnx-node` / ONNX model I/O differs from the code shown, adapt **inside the wrapper file only**, guided by `node_modules/sherpa-onnx-node/README.md` and a one-off `console.log(Object.keys(require("sherpa-onnx-node")))` — never change the wrapper's exported interface or the tests.

- [ ] **Step 1: Write fetch-models.ts**

```ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
```

- [ ] **Step 2: Run the fetcher and sanity-check**

Run: `pnpm --filter @claurp/daemon models`
Expected: four downloads into `~/.claurp/models/` (KWS tarball extracts to a directory containing `encoder-*.onnx`, `decoder-*.onnx`, `joiner-*.onnx`, `tokens.txt`, `bpe.model`, and a sample `keywords.txt` — `ls` it and note the exact directory name; Task 4 needs it). If any URL 404s, open the release/HF page, correct the filename in `MODELS`, re-run, and record final URLs + sha256s in `models/RECIPE.md` (created in Task 4).

- [ ] **Step 3: Write the failing VAD test**

`packages/daemon/test/audio/vad.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { int16ToFloat32, readWavPcm16Mono } from "../../src/audio/pcm.js";
import { modelPath } from "../../src/paths.js";
import { createSileroVad } from "../../src/audio/vad.js";

const FIX = join(import.meta.dirname, "..", "fixtures");
const haveModel = existsSync(modelPath("silero_vad.onnx"));

describe.skipIf(!haveModel)("silero vad", () => {
  function frames(file: string): Float32Array[] {
    const { pcm } = readWavPcm16Mono(join(FIX, file));
    const f32 = int16ToFloat32(pcm);
    const out: Float32Array[] = [];
    for (let i = 0; i + 512 <= f32.length; i += 512) out.push(f32.slice(i, i + 512));
    return out;
  }

  it("flags speech in a spoken fixture and none in silence", async () => {
    const vad = await createSileroVad();
    const speechHits = frames("plain_speech.wav").filter((f) => vad.isSpeech(f)).length;
    vad.reset();
    const silenceHits = frames("silence_2s.wav").filter((f) => vad.isSpeech(f)).length;
    expect(speechHits).toBeGreaterThan(10);
    expect(silenceHits).toBe(0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @claurp/daemon test -- vad`
Expected: FAIL — `vad.js` not found (test must not be skipped; if it skipped, re-run Step 2).

- [ ] **Step 5: Implement vad.ts**

`packages/daemon/src/audio/vad.ts` (per the vendor-API note, adjust call sites only if the installed README differs):

```ts
import sherpa from "sherpa-onnx-node";
import { modelPath } from "../paths.js";

export interface VadGate {
  isSpeech(frame: Float32Array): boolean; // 512 samples @ 16 kHz
  reset(): void;
}

export async function createSileroVad(opts: { threshold?: number } = {}): Promise<VadGate> {
  const config = {
    sileroVad: {
      model: modelPath("silero_vad.onnx"),
      threshold: opts.threshold ?? 0.5,
      minSilenceDuration: 0.25,
      minSpeechDuration: 0.1,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: 1,
    debug: false,
  };
  const vad = new sherpa.Vad(config, 30 /* buffer seconds */);
  return {
    isSpeech(frame: Float32Array): boolean {
      vad.acceptWaveform(frame);
      return vad.isDetected();
    },
    reset(): void {
      vad.clear();
    },
  };
}
```

Add `"sherpa-onnx-node": "^1.12.0"` to daemon dependencies and `pnpm install`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- vad`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(daemon): model fetcher and silero VAD gate"
```

---

### Task 4: Wake spotter (sherpa-onnx KWS) + committed keyword asset

**Files:**
- Create: `packages/daemon/src/audio/wake.ts`
- Create: `models/keywords-hey-claude.txt` (generated once, committed)
- Create: `models/RECIPE.md` (asset provenance: URLs, sha256s, generation commands)
- Test: `packages/daemon/test/audio/wake.test.ts`

**Interfaces:**
- Consumes: `modelPath`, pcm utils (Task 2); KWS model directory from Task 3 Step 2.
- Produces: `interface WakeSpotter { feed(frame: Float32Array): string | null; reset(): void }` (returns the keyword id, e.g. `"HEY_CLAUDE"`, on the frame where it fires) and `createWakeSpotter(opts?: { keywordsFile?: string }): Promise<WakeSpotter>`.

- [ ] **Step 1: Generate the keyword asset (dev-time, output committed)**

The KWS model matches token sequences, so "hey claude" must be encoded with the model's own BPE. One-off command (Python via uvx is acceptable dev tooling per Global Constraints — the *output* is committed and runtime never touches Python):

```bash
KWS_DIR=~/.claurp/models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01   # from Task 3 Step 2
printf 'HEY CLAUDE @HEY_CLAUDE\n' > /tmp/kw-raw.txt
uvx --from sherpa-onnx sherpa-onnx-cli text2token \
  --tokens "$KWS_DIR/tokens.txt" --tokens-type bpe --bpe-model "$KWS_DIR/bpe.model" \
  /tmp/kw-raw.txt models/keywords-hey-claude.txt
cat models/keywords-hey-claude.txt   # expect one line of BPE pieces ending in @HEY_CLAUDE
```

If the subcommand name differs in the installed version, `uvx --from sherpa-onnx sherpa-onnx-cli --help` lists it. Then write `models/RECIPE.md` recording: the four model URLs + sha256s from Task 3, this exact command, and the sherpa-onnx version used. **Open question #1 from the spec goes here too:** record the KWS model's license status as found on its release page; if it turns out restrictive, file an issue to swap in local-wake enrollment before v0.1 ships.

- [ ] **Step 2: Write the failing wake test**

`packages/daemon/test/audio/wake.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { int16ToFloat32, readWavPcm16Mono } from "../../src/audio/pcm.js";
import { modelPath } from "../../src/paths.js";
import { createWakeSpotter } from "../../src/audio/wake.js";

const FIX = join(import.meta.dirname, "..", "fixtures");
const KWS_DIR = modelPath("sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01");

function runOver(file: string, spotter: { feed(f: Float32Array): string | null }): string | null {
  const f32 = int16ToFloat32(readWavPcm16Mono(join(FIX, file)).pcm);
  for (let i = 0; i + 512 <= f32.length; i += 512) {
    const hit = spotter.feed(f32.slice(i, i + 512));
    if (hit) return hit;
  }
  return null;
}

describe.skipIf(!existsSync(KWS_DIR))("wake spotter", () => {
  it("fires on 'hey claude' and stays quiet on unrelated speech and silence", async () => {
    const s = await createWakeSpotter();
    expect(runOver("hey_claude.wav", s)).toBe("HEY_CLAUDE");
    s.reset();
    expect(runOver("plain_speech.wav", s)).toBeNull();
    s.reset();
    expect(runOver("silence_2s.wav", s)).toBeNull();
  });

  it("fires when the wake phrase leads a longer utterance", async () => {
    const s = await createWakeSpotter();
    expect(runOver("hey_claude_create_file.wav", s)).toBe("HEY_CLAUDE");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @claurp/daemon test -- wake`
Expected: FAIL — `wake.js` not found.

- [ ] **Step 4: Implement wake.ts**

```ts
import { existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import sherpa from "sherpa-onnx-node";
import { modelPath } from "../paths.js";

export interface WakeSpotter {
  feed(frame: Float32Array): string | null;
  reset(): void;
}

const KWS_DIR = modelPath("sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01");

function file(prefix: string): string {
  const hit = readdirSync(KWS_DIR).find((f) => f.startsWith(prefix) && f.endsWith(".onnx"));
  if (!hit) throw new Error(`no ${prefix}*.onnx in ${KWS_DIR}`);
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
    keywordsThreshold: 0.25,
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
```

(Vendor-API note from Task 3 applies: adapt call sites to the installed README if needed; interface and tests stay.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- wake`
Expected: 2 passing. If the spotter misses the synthetic voice, lower `keywordsThreshold` to 0.15 and/or raise `keywordsScore` to 3.0 — tune the constant, do not weaken the test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(daemon): sherpa-onnx wake spotter with committed hey-claude keyword asset"
```

---

### Task 5: Transcriber (whisper.cpp server child)

**Files:**
- Create: `packages/daemon/src/audio/transcriber.ts`
- Test: `packages/daemon/test/audio/transcriber.test.ts`

**Interfaces:**
- Consumes: `writeWavPcm16Mono`, `modelPath` (Task 2/3); Homebrew `whisper-server` on PATH (`brew install whisper-cpp`).
- Produces:

```ts
export interface Transcriber {
  start(): Promise<void>;                      // boots backend; resolves when healthy
  transcribe(pcm16k: Int16Array): Promise<string>; // full-buffer inference (used for partials AND finals)
  stop(): Promise<void>;
}
export function createWhisperTranscriber(opts?: { modelFile?: string; port?: number }): Transcriber;
```

- [ ] **Step 1: Install the runtime dependency**

Run: `brew install whisper-cpp` then `which whisper-server`
Expected: a path. (Plan 3 replaces brew with a bundled binary; for this plan brew is fine and is documented in RECIPE.md.)

- [ ] **Step 2: Write the failing test**

`packages/daemon/test/audio/transcriber.test.ts`:

```ts
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
    expect(text).toContain("haiku");
  });

  it("returns empty-ish text for silence", async () => {
    const { pcm } = readWavPcm16Mono(join(FIX, "silence_2s.wav"));
    const text = (await t.transcribe(pcm)).trim();
    expect(text.length).toBeLessThan(20); // whisper sometimes emits "[BLANK_AUDIO]"-ish noise
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @claurp/daemon test -- transcriber`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement transcriber.ts**

```ts
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
      const r = await fetch(`http://127.0.0.1:${port}/`, { method: "GET" });
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- transcriber`
Expected: 2 passing (first run is slow while the model loads).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(daemon): whisper.cpp transcriber behind Transcriber interface"
```

---
### Task 6: Turn detector (smart-turn v3)

**Files:**
- Create: `packages/daemon/src/audio/turn.ts`
- Test: `packages/daemon/test/audio/turn.test.ts`

**Interfaces:**
- Consumes: `modelPath`, pcm utils; `smart-turn-v3.onnx` from Task 3; `onnxruntime-node` (add `^1.19.2` to daemon dependencies).
- Produces: `interface TurnDetector { isComplete(pcm16k: Float32Array): Promise<boolean> }` and `createSmartTurn(opts?: { threshold?: number }): Promise<TurnDetector>` — callers pass the utterance-so-far; the implementation windows to the last 8 s internally.

- [ ] **Step 1: Discover the model's I/O (one-off, not committed)**

```bash
node -e "
const ort = require('onnxruntime-node');
ort.InferenceSession.create(process.env.HOME + '/.claurp/models/smart-turn-v3.onnx').then(s => {
  console.log('inputs:', s.inputNames, 'outputs:', s.outputNames);
});"
```

Record the exact input/output tensor names in a comment at the top of `turn.ts`. Expectation from the smart-turn docs: one float input of 8 s of 16 kHz audio, one probability-like output; if the discovered shape differs (e.g. an attention-mask second input), adapt inside `turn.ts` per the Task 3 vendor-API note.

- [ ] **Step 2: Write the failing test**

`packages/daemon/test/audio/turn.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { int16ToFloat32, readWavPcm16Mono } from "../../src/audio/pcm.js";
import { modelPath } from "../../src/paths.js";
import { createSmartTurn } from "../../src/audio/turn.js";

const FIX = join(import.meta.dirname, "..", "fixtures");
const haveModel = existsSync(modelPath("smart-turn-v3.onnx"));

describe.skipIf(!haveModel)("smart-turn v3", () => {
  it("marks a finished sentence complete and a mid-word cut incomplete", async () => {
    const turn = await createSmartTurn();
    const full = int16ToFloat32(readWavPcm16Mono(join(FIX, "hey_claude_create_file.wav")).pcm);
    // cut at 55% of the speech — mid-utterance, no trailing silence
    const cut = full.slice(0, Math.floor(full.length * 0.55));
    expect(await turn.isComplete(full)).toBe(true);
    expect(await turn.isComplete(cut)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @claurp/daemon test -- turn`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement turn.ts**

```ts
// smart-turn v3 ONNX. Discovered I/O (Task 6 Step 1): <record names here>.
import * as ort from "onnxruntime-node";
import { modelPath } from "../paths.js";

export interface TurnDetector {
  isComplete(pcm16k: Float32Array): Promise<boolean>;
}

const WINDOW = 8 * 16000;

export async function createSmartTurn(opts: { threshold?: number } = {}): Promise<TurnDetector> {
  const threshold = opts.threshold ?? 0.5;
  const session = await ort.InferenceSession.create(modelPath("smart-turn-v3.onnx"));
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  return {
    async isComplete(pcm16k: Float32Array): Promise<boolean> {
      const window = new Float32Array(WINDOW); // zero-padded head
      const tail = pcm16k.slice(Math.max(0, pcm16k.length - WINDOW));
      window.set(tail, WINDOW - tail.length);
      const feeds: Record<string, ort.Tensor> = {
        [inputName]: new ort.Tensor("float32", window, [1, WINDOW]),
      };
      const out = await session.run(feeds);
      const data = out[outputName].data as Float32Array;
      // single logit/probability; if the model emits a logit, squash it
      const v = data[0];
      const p = v >= 0 && v <= 1 ? v : 1 / (1 + Math.exp(-v));
      return p > threshold;
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- turn`
Expected: PASS. If the synthetic voice sits near the boundary, tune `threshold` (0.4–0.6) once and leave a comment with the observed probabilities — do not loosen the assertions.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(daemon): smart-turn v3 end-of-utterance detector"
```

---

### Task 7: Audio pipeline state machine

**Files:**
- Create: `packages/daemon/src/audio/pipeline.ts`
- Test: `packages/daemon/test/audio/pipeline.test.ts` (unit, fakes) and `packages/daemon/test/audio/pipeline.integration.test.ts` (real components)

**Interfaces:**
- Consumes: `VadGate` (T3), `WakeSpotter` (T4), `Transcriber` (T5), `TurnDetector` (T6) — all constructor-injected.
- Produces:

```ts
export type PipelineEvent =
  | { kind: "wake" }
  | { kind: "partial"; text: string }
  | { kind: "final"; text: string };

export interface AudioPipelineDeps {
  vad: VadGate; wake: WakeSpotter; transcriber: Transcriber; turn: TurnDetector;
}
export class AudioPipeline {
  constructor(deps: AudioPipelineDeps, onEvent: (e: PipelineEvent) => void);
  feed(frame: Int16Array): Promise<void>;  // 512 samples @16k; serialized internally
  pttDown(): void;                          // enter listening without wake word
  pttUp(): Promise<void>;                   // force finalize
}
```

Behavior (all timing in *audio frames*, 512 samples = 32 ms, so tests are deterministic):
- **idle:** run VAD per frame; feed the wake spotter only on speech frames or within a 15-frame hangover. On wake hit → emit `wake`, clear buffer, → **listening** (the command follows the wake phrase in the same breath; buffering starts at the hit).
- **listening:** append every frame to the utterance buffer. Every 25 new frames (~800 ms) with ≥ 38 frames buffered (~1.2 s) → `transcriber.transcribe(buffer)` → emit `partial`. Track trailing non-speech frames via VAD: at ≥ 13 (~400 ms) consult `turn.isComplete(buffer)`; complete → finalize. At ≥ 78 trailing (~2.5 s) → finalize regardless (fallback). At 3750 frames (~120 s) → hard finalize.
- **finalize:** final text = `transcribe(buffer)` with the leading wake phrase stripped via `/^\s*(hey[,.\s]+claude[,.!?\s]*)/i` → emit `final` (skip emit if empty after stripping) → reset vad + wake → **idle**.
- `pttDown()` from idle → listening (no wake event); `pttUp()` → finalize.

- [ ] **Step 1: Write the failing unit test (fakes)**

`packages/daemon/test/audio/pipeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AudioPipeline, type PipelineEvent } from "../../src/audio/pipeline.js";
import { silence } from "../../src/audio/pcm.js";

const FRAME = 512;
function speechFrame(): Int16Array { return new Int16Array(FRAME).fill(1000); }
function quietFrame(): Int16Array { return new Int16Array(FRAME); }

function makeFakes(opts: { wakeAtFrame: number; completeAfterBufferFrames: number }) {
  let fed = 0;
  return {
    vad: { isSpeech: (f: Float32Array) => f.some((s) => s !== 0), reset: () => void 0 },
    wake: {
      feed: () => (++fed === opts.wakeAtFrame ? "HEY_CLAUDE" : null),
      reset: () => void 0,
    },
    transcriber: {
      start: async () => void 0,
      stop: async () => void 0,
      transcribe: async (pcm: Int16Array) =>
        `hey claude, fake transcript of ${Math.round(pcm.length / FRAME)} frames`,
    },
    turn: {
      isComplete: async (pcm: Float32Array) => pcm.length / FRAME >= opts.completeAfterBufferFrames,
    },
  };
}

describe("audio pipeline state machine", () => {
  it("wake → partials → turn-complete finalize, with wake phrase stripped", async () => {
    const events: PipelineEvent[] = [];
    const p = new AudioPipeline(makeFakes({ wakeAtFrame: 5, completeAfterBufferFrames: 40 }), (e) =>
      events.push(e),
    );
    for (let i = 0; i < 10; i++) await p.feed(speechFrame());       // wake fires at frame 5
    for (let i = 0; i < 45; i++) await p.feed(speechFrame());       // command speech
    for (let i = 0; i < 20; i++) await p.feed(quietFrame());        // trailing silence → turn check
    expect(events[0]).toEqual({ kind: "wake" });
    expect(events.some((e) => e.kind === "partial")).toBe(true);
    const final = events.at(-1)!;
    expect(final.kind).toBe("final");
    expect((final as { text: string }).text.startsWith("fake transcript")).toBe(true); // "hey claude, " stripped
  });

  it("silence fallback finalizes even when turn detector never completes", async () => {
    const events: PipelineEvent[] = [];
    const p = new AudioPipeline(makeFakes({ wakeAtFrame: 3, completeAfterBufferFrames: 9999 }), (e) =>
      events.push(e),
    );
    for (let i = 0; i < 50; i++) await p.feed(speechFrame());
    for (let i = 0; i < 85; i++) await p.feed(quietFrame());        // > 78 trailing frames
    expect(events.at(-1)!.kind).toBe("final");
  });

  it("ptt enters listening without wake and pttUp finalizes", async () => {
    const events: PipelineEvent[] = [];
    const p = new AudioPipeline(makeFakes({ wakeAtFrame: 9999, completeAfterBufferFrames: 9999 }), (e) =>
      events.push(e),
    );
    p.pttDown();
    for (let i = 0; i < 45; i++) await p.feed(speechFrame());
    await p.pttUp();
    expect(events.some((e) => e.kind === "wake")).toBe(false);
    expect(events.at(-1)!.kind).toBe("final");
  });

  it("ignores everything while idle without wake", async () => {
    const events: PipelineEvent[] = [];
    const p = new AudioPipeline(makeFakes({ wakeAtFrame: 9999, completeAfterBufferFrames: 10 }), (e) =>
      events.push(e),
    );
    for (let i = 0; i < 60; i++) await p.feed(speechFrame());
    expect(events).toEqual([]);
  });

  it("suppresses empty finals (wake with no command)", async () => {
    const fakes = makeFakes({ wakeAtFrame: 3, completeAfterBufferFrames: 9999 });
    fakes.transcriber.transcribe = async () => "hey claude";
    const events: PipelineEvent[] = [];
    const p = new AudioPipeline(fakes, (e) => events.push(e));
    for (let i = 0; i < 10; i++) await p.feed(speechFrame());
    for (let i = 0; i < 85; i++) await p.feed(quietFrame());
    expect(events.filter((e) => e.kind === "final")).toEqual([]);
    void silence; // keep import used if unused elsewhere
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @claurp/daemon test -- pipeline.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement pipeline.ts**

Implement exactly the behavior table above. Internal shape: a `state: "idle" | "listening"` field, `buffer: Int16Array[]`, counters `framesSinceWake`, `framesSincePartial`, `trailingQuiet`, and a promise-chain `queue` so `feed()` serializes (`this.queue = this.queue.then(() => this.process(frame))`). Partial/final transcribe calls are awaited inside the chain; `isSpeech` is computed once per frame on the float32 conversion and reused for wake gating and trailing-quiet counting. Reset `vad`/`wake` and all counters in `finalize()`. Keep the file well under 200 lines.

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- pipeline.test`
Expected: 5 passing.

- [ ] **Step 5: Write and run the integration test (real components)**

`packages/daemon/test/audio/pipeline.integration.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AudioPipeline, type PipelineEvent } from "../../src/audio/pipeline.js";
import { concatInt16, readWavPcm16Mono, silence } from "../../src/audio/pcm.js";
import { modelPath } from "../../src/paths.js";
import { createSileroVad } from "../../src/audio/vad.js";
import { createWakeSpotter } from "../../src/audio/wake.js";
import { createSmartTurn } from "../../src/audio/turn.js";
import { createWhisperTranscriber, type Transcriber } from "../../src/audio/transcriber.js";

const FIX = join(import.meta.dirname, "..", "fixtures");
const ready =
  existsSync(modelPath("silero_vad.onnx")) &&
  existsSync(modelPath("smart-turn-v3.onnx")) &&
  existsSync(modelPath("ggml-base.en.bin"));

describe.skipIf(!ready)("pipeline integration (real models)", () => {
  let t: Transcriber;
  beforeAll(async () => { t = createWhisperTranscriber({ port: 17772 }); await t.start(); });
  afterAll(async () => { await t.stop(); });

  it("wav in → wake + final transcript out", async () => {
    const events: PipelineEvent[] = [];
    const p = new AudioPipeline(
      { vad: await createSileroVad(), wake: await createWakeSpotter(), transcriber: t, turn: await createSmartTurn() },
      (e) => events.push(e),
    );
    const utterance = readWavPcm16Mono(join(FIX, "hey_claude_create_file.wav")).pcm;
    const stream = concatInt16([silence(16000, 1), utterance, silence(16000, 3)]);
    for (let i = 0; i + 512 <= stream.length; i += 512) await p.feed(stream.slice(i, i + 512) as Int16Array);
    expect(events.some((e) => e.kind === "wake")).toBe(true);
    const final = events.find((e) => e.kind === "final") as { kind: "final"; text: string } | undefined;
    expect(final).toBeDefined();
    expect(final!.text.toLowerCase()).toContain("haiku");
    expect(final!.text.toLowerCase()).not.toContain("hey claude");
  }, 180_000);
});
```

Run: `pnpm --filter @claurp/daemon test -- pipeline.integration`
Expected: PASS (slow; whisper does several partial passes).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(daemon): audio pipeline state machine with wake/ptt, partials, smart-turn finalize"
```

---

### Task 8: Intent router (verb grammar)

**Files:**
- Create: `packages/protocol/src/intents.ts` (types), `packages/daemon/src/router.ts` (parser)
- Modify: `packages/protocol/src/index.ts` (add `export * from "./intents.js";`)
- Test: `packages/daemon/test/router.test.ts`

**Interfaces:**
- Consumes: nothing at runtime (pure function).
- Produces (in `@claurp/protocol`):

```ts
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type Intent =
  | { kind: "prompt"; text: string; project?: string }
  | { kind: "session"; op: "new"; prompt: string; project?: string }
  | { kind: "session"; op: "status" | "kill" | "handoff" }
  | { kind: "session"; op: "switch"; target: string }
  | { kind: "permission"; decision: "allow" | "deny" | "always" | "detail" }
  | { kind: "mode"; mode: PermissionMode; confirmed: boolean }
  | { kind: "meta"; query: "usage" | "contextFill" | "status" }
  | { kind: "capture"; target: "screen" | "camera" };
```

and in the daemon: `parseIntent(text: string): Intent`.

- [ ] **Step 1: Write the failing table-driven test**

`packages/daemon/test/router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Intent } from "@claurp/protocol";
import { parseIntent } from "../src/router.js";

const cases: Array<[string, Intent]> = [
  ["allow", { kind: "permission", decision: "allow" }],
  ["Yes.", { kind: "permission", decision: "allow" }],
  ["deny", { kind: "permission", decision: "deny" }],
  ["no", { kind: "permission", decision: "deny" }],
  ["allow always", { kind: "permission", decision: "always" }],
  ["always allow", { kind: "permission", decision: "always" }],
  ["what exactly?", { kind: "permission", decision: "detail" }],
  ["plan mode", { kind: "mode", mode: "plan", confirmed: true }],
  ["auto accept edits", { kind: "mode", mode: "acceptEdits", confirmed: true }],
  ["auto-accept edits", { kind: "mode", mode: "acceptEdits", confirmed: true }],
  ["normal mode", { kind: "mode", mode: "default", confirmed: true }],
  ["bypass permissions", { kind: "mode", mode: "bypassPermissions", confirmed: false }],
  ["confirm bypass", { kind: "mode", mode: "bypassPermissions", confirmed: true }],
  ["status", { kind: "meta", query: "status" }],
  ["what's the status?", { kind: "meta", query: "status" }],
  ["how much have I used this week", { kind: "meta", query: "usage" }],
  ["usage", { kind: "meta", query: "usage" }],
  ["how full is this session", { kind: "meta", query: "contextFill" }],
  ["new task: fix the flaky test", { kind: "session", op: "new", prompt: "fix the flaky test" }],
  ["kill it", { kind: "session", op: "kill" }],
  ["stop that", { kind: "session", op: "kill" }],
  ["switch to the auth one", { kind: "session", op: "switch", target: "the auth one" }],
  ["show me the session", { kind: "session", op: "handoff" }],
  ["open it in the terminal", { kind: "session", op: "handoff" }],
  ["look at my screen", { kind: "capture", target: "screen" }],
  ["check this out", { kind: "capture", target: "camera" }],
  ["refactor the auth flow and add tests", { kind: "prompt", text: "refactor the auth flow and add tests" }],
  // spec §5.1: leading "in <project-name>," routes by named project
  ["in dotfiles, update my zsh aliases", { kind: "prompt", text: "update my zsh aliases", project: "dotfiles" }],
  ["in notes new task: draft the readme", { kind: "session", op: "new", prompt: "draft the readme", project: "notes" }],
  ["in dotfiles, status", { kind: "meta", query: "status" }],   // project prefix ignored for non-prompt intents
];

describe("parseIntent", () => {
  it.each(cases)("%s", (text, expected) => {
    expect(parseIntent(text)).toEqual(expected);
  });

  it("treats near-miss verbs as prompts (no fuzzy guessing in v0.1)", () => {
    expect(parseIntent("please allow more logging in the app")).toEqual({
      kind: "prompt",
      text: "please allow more logging in the app",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @claurp/daemon test -- router`
Expected: FAIL.

- [ ] **Step 3: Implement intents.ts + router.ts**

`router.ts` normalizes (`lowercase`, strip terminal punctuation, collapse whitespace), then **peels an optional project prefix** `/^in\s+([\w-]+)[,:]?\s+/` before matching; the captured name attaches only to `prompt` and `session/new` results and is dropped for every other intent kind. Then match **anchored** regexes in priority order: permission → mode → meta → session → capture → prompt fallback. Verbs must match the *whole* utterance (`^…$`) except `new task` (captures the remainder) and `switch to` (captures the target) — that is what keeps "please allow more logging" a prompt. Copy the exact vocab from the test table; nothing fuzzier in v0.1 (spec §4: no LLM in the hot path).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- router`
Expected: all table cases + the near-miss case passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(daemon): intent router with anchored verb grammar"
```

---

### Task 9: Adapter contract + FakeAgent + shared contract suite

**Files:**
- Create: `packages/protocol/src/adapter.ts`
- Modify: `packages/protocol/src/index.ts` (add `export * from "./adapter.js";`)
- Create: `packages/daemon/src/agents/fake.ts`, `packages/daemon/src/agents/contract.ts`
- Test: `packages/daemon/test/agents/fake.test.ts`

**Interfaces:**
- Consumes: `PermissionMode` from Task 8's `intents.ts`.
- Produces (in `@claurp/protocol` — **this is the contract every adapter and Task 10/12/16 compiles against; copy signatures exactly**):

```ts
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg"; base64: string }; // v0.2 uses images; v0.1 sends text only

export type AgentEvent =
  | { kind: "started"; backendSessionId: string | null }
  | { kind: "text-delta"; text: string }
  | { kind: "tool-use"; tool: string; detail: string }
  | { kind: "needs-permission"; requestId: string; tool: string; detail: string }
  | { kind: "needs-input"; prompt: string }
  | { kind: "usage-metadata"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { kind: "done"; summary?: string }
  | { kind: "error"; message: string };

export interface SpawnOpts { cwd: string; prompt: string; permissionMode: PermissionMode }

export interface SessionHandle {
  send(blocks: ContentBlock[]): void;
  interrupt(): void;
  setPermissionMode(mode: PermissionMode): void;
  respondPermission(requestId: string, decision: "allow" | "deny"): void;
  events(): AsyncIterable<AgentEvent>;
  handoffCommand(): string | null;
  kill(): void;
}

export interface AdapterCapabilities {
  images: boolean;
  permissions: "callback" | "flags" | "none";
  resume: boolean;
  queuedInput: boolean;
  permissionModes: PermissionMode[];
}

export interface AgentAdapter {
  readonly name: string;
  capabilities(): AdapterCapabilities;
  spawn(opts: SpawnOpts): SessionHandle;
}
```

- `FakeAgent implements AgentAdapter` (`name: "fake"`): default script on spawn — `started` → `tool-use {tool:"Write", detail:"write notes.txt"}` → `needs-permission {requestId:"r1", tool:"Write", detail:"write notes.txt"}` → *waits* → on `respondPermission("r1","allow")`: `text-delta "Created notes.txt with a haiku."` → `usage-metadata {inputTokens:1200, outputTokens:80, costUsd:0.01}` → `done {summary:"created notes.txt"}`; on deny: `text-delta "Okay, skipping that."` → `done`. If `permissionMode` is `acceptEdits` or `bypassPermissions` at the time the tool fires, skip `needs-permission` and auto-continue. `send()` mid-session emits `text-delta "noted: <text>"`. `handoffCommand()` → `null`. Capabilities: `{ images: false, permissions: "callback", resume: false, queuedInput: true, permissionModes: ["default","acceptEdits","plan","bypassPermissions"] }`. Implement `events()` over an internal push-queue (async iterator that drains pushed events and closes after `done`/`error`/`kill`).
- `agents/contract.ts` exports `adapterContractSuite(label: string, make: () => AgentAdapter): void` — a vitest `describe` block reused by Task 12.

- [ ] **Step 1: Write the failing test (contract suite + fake specifics)**

`packages/daemon/test/agents/fake.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@claurp/protocol";
import { FakeAgent } from "../../src/agents/fake.js";
import { adapterContractSuite } from "../../src/agents/contract.js";

async function collect(events: AsyncIterable<AgentEvent>, until: AgentEvent["kind"] = "done") {
  const out: AgentEvent[] = [];
  for await (const e of events) { out.push(e); if (e.kind === until || e.kind === "error") break; }
  return out;
}

adapterContractSuite("fake", () => new FakeAgent());

describe("FakeAgent specifics", () => {
  it("allow path reaches done with prior text", async () => {
    const s = new FakeAgent().spawn({ cwd: "/tmp", prompt: "make notes", permissionMode: "default" });
    const seen: AgentEvent[] = [];
    for await (const e of s.events()) {
      seen.push(e);
      if (e.kind === "needs-permission") s.respondPermission(e.requestId, "allow");
      if (e.kind === "done") break;
    }
    expect(seen.map((e) => e.kind)).toEqual([
      "started", "tool-use", "needs-permission", "text-delta", "usage-metadata", "done",
    ]);
  });

  it("acceptEdits mode skips the permission ask", async () => {
    const s = new FakeAgent().spawn({ cwd: "/tmp", prompt: "make notes", permissionMode: "acceptEdits" });
    const seen = await collect(s.events());
    expect(seen.some((e) => e.kind === "needs-permission")).toBe(false);
    expect(seen.at(-1)!.kind).toBe("done");
  });
});
```

`agents/contract.ts` must assert, for any adapter: first event is `started`; a `needs-permission` event (when one occurs) is followed by nothing until `respondPermission` is called, after which the stream reaches `done` on allow and `done` (not `error`) on deny; the iterator terminates after `done`; `kill()` terminates a live iterator; `capabilities()` returns all five fields with the declared types.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @claurp/daemon test -- fake`
Expected: FAIL.

- [ ] **Step 3: Implement adapter.ts, fake.ts, contract.ts**

Write the three files exactly to the interfaces above. The push-queue iterator pattern for `events()`:

```ts
class EventQueue {
  private buf: AgentEvent[] = [];
  private waiters: Array<(v: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;
  push(e: AgentEvent): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: e, done: false }); else this.buf.push(e);
    if (e.kind === "done" || e.kind === "error") this.close();
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  iterate(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<AgentEvent>> => {
          const e = this.buf.shift();
          if (e) return Promise.resolve({ value: e, done: false });
          if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((res) => this.waiters.push(res));
        },
      }),
    };
  }
}
```

Put `EventQueue` in `agents/fake.ts` first; Task 12 moves it to a shared `agents/queue.ts` when Claude needs it too (do the move in Task 12, updating imports).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- fake`
Expected: contract suite + 2 specifics passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(daemon): adapter contract, FakeAgent, shared contract-test suite"
```

---
### Task 10: Named projects config + session manager

**Files:**
- Create: `packages/daemon/src/sessions/projects.ts`, `packages/daemon/src/sessions/manager.ts`
- Test: `packages/daemon/test/sessions/projects.test.ts`, `packages/daemon/test/sessions/manager.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `SessionHandle`, `AgentEvent`, `PermissionMode` (Task 9); `FakeAgent` in tests; `claurpHome()` (Task 2).
- Produces:

```ts
// projects.ts — config file ~/.claurp/config.json (CLAURP_HOME respected)
export interface Project { name: string; cwd: string }
export function loadProjects(): { defaultProject: Project; byName: Map<string, Project> };
// zod-validates { "defaultProject": "notes", "projects": { "notes": { "cwd": "~/dev/notes" } } },
// expands ~, path.resolve()s, throws a helpful error (with a template printed) when missing/invalid,
// and rejects any cwd that does not exist or is not absolute after resolution (spec §8: sanitize paths).

// manager.ts
export interface SessionRecord {
  id: string;                 // crypto.randomUUID()
  label: string;              // rule-based: first 4 non-stopword words of the prompt
  adapter: string;
  project: Project;
  state: "spawning" | "working" | "needs-permission" | "needs-input" | "done" | "failed" | "handed-off";
  permissionMode: PermissionMode;
  pendingPermission: { requestId: string; tool: string; detail: string } | null;
  handle: SessionHandle;
}
export class SessionManager {
  constructor(adapters: Map<string, AgentAdapter>, opts: { defaultAdapter: string });
  spawn(args: { prompt: string; project: Project; permissionMode?: PermissionMode }): SessionRecord;
  focused(): SessionRecord | null;      // most recently addressed OR most recently active
  noteActivity(id: string): void;       // called by the server when a session emits events
  switchTo(targetText: string): SessionRecord | null;  // case-insensitive label substring match
  consume(id: string, e: AgentEvent): void;            // lifecycle bookkeeping per the table below
  respondPermission(id: string, decision: "allow" | "deny"): void;
  setPermissionMode(id: string, mode: PermissionMode): void;
  kill(id: string): void;
  handoff(id: string): string | null;   // marks handed-off, returns handle.handoffCommand()
  roster(): SessionRecord[];
  onChange(cb: (r: SessionRecord) => void): void;
}
```

Lifecycle table for `consume`: `started`→`working`; `needs-permission`→state `needs-permission` + store `pendingPermission`; `needs-input`→`needs-input`; `text-delta`/`tool-use`/`usage-metadata`→(state unchanged, counts as activity); `done`→`done`; `error`→`failed`. `respondPermission` clears `pendingPermission`, sets state back to `working`, forwards to the handle. Label rule: lowercase prompt, drop `the a an please claude hey to in for of and`, take first 4 remaining words, join with spaces; fall back to `"task"` if empty.

- [ ] **Step 1: Write the failing tests**

`projects.test.ts` — point `CLAURP_HOME` at a temp dir per test (`beforeEach`): (a) valid config loads, `~` expands to `os.homedir()`, names map; (b) missing file throws with the word "template" in the message; (c) a project whose cwd does not exist throws; (d) relative cwd throws.

`manager.test.ts` (with `FakeAgent`):

```ts
import { describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../../src/agents/fake.js";
import { SessionManager } from "../../src/sessions/manager.js";

const project = { name: "tmp", cwd: "/tmp" };
function makeManager() {
  return new SessionManager(new Map([["fake", new FakeAgent()]]), { defaultAdapter: "fake" });
}

describe("SessionManager", () => {
  it("labels sessions from the prompt", () => {
    const m = makeManager();
    const r = m.spawn({ prompt: "please refactor the auth flow for me", project });
    expect(r.label).toBe("refactor auth flow me");
    expect(m.focused()!.id).toBe(r.id);
  });

  it("tracks lifecycle through events and pending permission", () => {
    const m = makeManager();
    const r = m.spawn({ prompt: "make notes", project });
    m.consume(r.id, { kind: "started", backendSessionId: null });
    expect(m.roster()[0].state).toBe("working");
    m.consume(r.id, { kind: "needs-permission", requestId: "r1", tool: "Write", detail: "write notes.txt" });
    expect(m.roster()[0].state).toBe("needs-permission");
    expect(m.roster()[0].pendingPermission?.requestId).toBe("r1");
    m.respondPermission(r.id, "allow");
    expect(m.roster()[0].state).toBe("working");
    expect(m.roster()[0].pendingPermission).toBeNull();
  });

  it("switchTo matches labels case-insensitively and refocuses", () => {
    const m = makeManager();
    m.spawn({ prompt: "refactor the auth flow", project });
    const b = m.spawn({ prompt: "write release notes", project });
    expect(m.focused()!.id).toBe(b.id);
    const hit = m.switchTo("the AUTH one");
    expect(hit?.label).toContain("auth");
    expect(m.focused()!.label).toContain("auth");
    expect(m.switchTo("nonexistent zebra")).toBeNull();
  });

  it("handoff marks the session and returns the command (null for fake)", () => {
    const m = makeManager();
    const r = m.spawn({ prompt: "make notes", project });
    expect(m.handoff(r.id)).toBeNull();               // FakeAgent has no resume
    expect(m.roster()[0].state).toBe("handed-off");
  });

  it("notifies onChange subscribers", () => {
    const m = makeManager();
    const cb = vi.fn();
    m.onChange(cb);
    const r = m.spawn({ prompt: "x", project });
    m.consume(r.id, { kind: "done" });
    expect(cb).toHaveBeenCalled();
    expect(m.roster()[0].state).toBe("done");
    void r;
  });
});
```

Note on `switchTo` matching: normalize the target by dropping the same stopwords as the label rule plus `one`, then require every remaining target word to appear in a label; most recent match wins ties.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @claurp/daemon test -- sessions`
Expected: FAIL.

- [ ] **Step 3: Implement projects.ts and manager.ts**

Straight transcription of the interfaces and tables above. Keep `manager.ts` free of WS/protocol imports — it knows adapters and records only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- sessions`
Expected: all passing (projects 4, manager 5).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(daemon): named projects config and session manager with focus/lifecycle rules"
```

---

### Task 11: Permission policy engine

**Files:**
- Create: `packages/daemon/src/policy.ts`
- Test: `packages/daemon/test/policy.test.ts`

**Interfaces:**
- Consumes: `claurpHome()` (Task 2).
- Produces:

```ts
export type RiskClass = "read" | "write" | "exec" | "network";
export function classify(tool: string, detail: string): RiskClass;
// Read/Grep/Glob/NotebookRead → read; Edit/Write/MultiEdit/NotebookEdit → write;
// WebFetch/WebSearch → network; Bash → exec, except detail matching /\b(curl|wget|https?:\/\/)/ → network;
// unknown tools → exec (conservative).

export function hardDeny(tool: string, detail: string): boolean;
// spec §5.4 deny-list, never auto-allowed and never "always"-able:
//   recursive/forced deletes: /\brm\s+-[a-z]*[rf][a-z]*[rf]?\b/ and /\bgit\s+clean\b.*-[a-z]*f/
//   force-push: /\bgit\s+push\b.*(--force|-f\b)/
//   history rewrites: /\bgit\s+(reset\s+--hard|rebase|filter-branch)\b/
//   discarding changes: /\bgit\s+checkout\s+--\s/
//   secret reads: tool ∈ {Read,Bash} and detail matching /(^|[\s\/])(\.env(\.[\w-]+)?|id_(rsa|ed25519)|[\w-]+\.pem|[\w-]+\.key|credentials?([\/.]|\b)|secrets?([\/.]|\b))/i

export type Verdict = { action: "auto-allow" } | { action: "ask"; alwaysable: true } | { action: "ask"; alwaysable: false };
export class PermissionPolicy {
  constructor();                                  // loads ~/.claurp/policy.json if present
  decide(tool: string, detail: string): Verdict;  // hardDeny → ask/alwaysable:false; class read or stored always-allow → auto-allow; else ask/alwaysable:true
  recordAlways(tool: string, detail: string): boolean; // persists {tool, class}; returns false (and stores nothing) for hard-deny matches
}
```

- [ ] **Step 1: Write the failing table-driven test**

`packages/daemon/test/policy.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { classify, hardDeny, PermissionPolicy } from "../src/policy.js";

beforeEach(() => { process.env.CLAURP_HOME = mkdtempSync(join(tmpdir(), "claurp-pol-")); });

describe("classify", () => {
  const cases: Array<[string, string, string]> = [
    ["Read", "src/app.ts", "read"],
    ["Grep", "TODO", "read"],
    ["Edit", "src/app.ts", "write"],
    ["Write", "notes.txt", "write"],
    ["Bash", "npm test", "exec"],
    ["Bash", "curl https://example.com", "network"],
    ["WebFetch", "https://example.com", "network"],
    ["MysteryTool", "whatever", "exec"],
  ];
  it.each(cases)("%s %s → %s", (tool, detail, cls) => expect(classify(tool, detail)).toBe(cls));
});

describe("hardDeny", () => {
  const denied: Array<[string, string]> = [
    ["Bash", "rm -rf ./build"],
    ["Bash", "rm -fr /tmp/x"],
    ["Bash", "git push --force origin main"],
    ["Bash", "git push -f"],
    ["Bash", "git reset --hard HEAD~3"],
    ["Bash", "git rebase -i main"],
    ["Bash", "git checkout -- ."],
    ["Bash", "git clean -fd"],
    ["Bash", "cat .env"],
    ["Read", "/Users/x/.env.production"],
    ["Read", "~/.ssh/id_rsa"],
    ["Read", "deploy/server.pem"],
  ];
  const allowed: Array<[string, string]> = [
    ["Bash", "rm build/out.txt"],
    ["Bash", "git push origin feature"],
    ["Bash", "git checkout feature-branch"],
    ["Read", "src/environment.ts"],
    ["Read", "docs/secrets-policy.md"],   // word boundary: mentions secrets in a doc *name* — tune regex if this fails
  ];
  it.each(denied)("denies %s %s", (t, d) => expect(hardDeny(t, d)).toBe(true));
  it.each(allowed)("permits %s %s", (t, d) => expect(hardDeny(t, d)).toBe(false));
});

describe("PermissionPolicy", () => {
  it("auto-allows reads, asks for writes, refuses always on hard-deny", () => {
    const p = new PermissionPolicy();
    expect(p.decide("Read", "src/app.ts")).toEqual({ action: "auto-allow" });
    expect(p.decide("Write", "notes.txt")).toEqual({ action: "ask", alwaysable: true });
    expect(p.decide("Bash", "git push --force")).toEqual({ action: "ask", alwaysable: false });
    expect(p.recordAlways("Bash", "git push --force")).toBe(false);
  });

  it("persists always-allow across instances by class+tool", () => {
    const p1 = new PermissionPolicy();
    expect(p1.recordAlways("Bash", "npm test")).toBe(true);
    const p2 = new PermissionPolicy();
    expect(p2.decide("Bash", "npm run lint")).toEqual({ action: "auto-allow" }); // same tool+class
    expect(p2.decide("Bash", "curl https://x.dev")).toEqual({ action: "ask", alwaysable: true }); // network class still asks
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @claurp/daemon test -- policy`
Expected: FAIL.

- [ ] **Step 3: Implement policy.ts**

Transcribe the regexes and rules from the interface block. The `docs/secrets-policy.md` case pins the false-positive boundary: the secret-read pattern requires the match to be a path-ish token (preceded by start, whitespace, or `/`) and to end at a path boundary — a hyphenated compound like `secrets-policy` must not match; get the test green by regex precision, not by deleting the case.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- policy`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(daemon): permission policy engine with hard deny-list"
```

---

### Task 12: Claude Code adapter (Agent SDK)

**Files:**
- Create: `packages/daemon/src/agents/claude.ts`, `packages/daemon/src/agents/queue.ts` (move `EventQueue` out of `fake.ts`; update `fake.ts` imports)
- Test: `packages/daemon/test/agents/claude.test.ts` (mocked), `packages/daemon/test/agents/claude.smoke.test.ts` (real, env-gated)
- Modify: `packages/daemon/package.json` — run `pnpm --filter @claurp/daemon add @anthropic-ai/claude-agent-sdk@latest` and record the resolved version in the commit message.

**Interfaces:**
- Consumes: the full adapter contract from Task 9; `adapterContractSuite`.
- Produces: `class ClaudeAdapter implements AgentAdapter` with `name: "claude"`, capabilities `{ images: true, permissions: "callback", resume: true, queuedInput: true, permissionModes: ["default","acceptEdits","plan","bypassPermissions"] }`, and a test-seam constructor: `new ClaudeAdapter(opts?: { queryFn?: QueryFn })` where `QueryFn = (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => AsyncGenerator<unknown> & { interrupt?(): Promise<void>; setPermissionMode?(m: string): Promise<void> }`. Default `queryFn` is the SDK's `query`.

**SDK mapping (implementation contract):**
- `spawn(opts)` calls `queryFn` with `options`: `{ cwd: opts.cwd, permissionMode: opts.permissionMode, settingSources: ["user", "project", "local"], canUseTool }` — `settingSources` is the "your CLAUDE.md, your MCP servers, your skills" promise (spec §5.3); assert it in tests verbatim.
- The `prompt` argument is an async generator: yields `{ type: "user", message: { role: "user", content: [{ type: "text", text: opts.prompt }] }, parent_tool_use_id: null, session_id: "" }` first, then loops over an internal send-queue fed by `send(blocks)` (map our `ContentBlock` → SDK content: text → `{type:"text",text}`, image → `{type:"image",source:{type:"base64",media_type,data}}`).
- `canUseTool: async (toolName, input) => Promise` — mint `requestId = randomUUID()`, emit `needs-permission { requestId, tool: toolName, detail }` where `detail` is `input.command` when present else compact-JSON of `input` truncated to 200 chars; park the promise's `resolve` in a `Map<requestId, resolve>`. `respondPermission(requestId, "allow")` → resolve `{ behavior: "allow", updatedInput: input }`; deny → `{ behavior: "deny", message: "denied by voice" }`.
- Incoming SDK messages → events: `type:"system", subtype:"init"` → `started { backendSessionId: msg.session_id }` (also cache for `handoffCommand`); `type:"assistant"` → for each content block: text → `text-delta`, `tool_use` → `tool-use { tool: block.name, detail: block.input?.command ?? compactJson(block.input) }`; and if `msg.message.usage` exists → `usage-metadata { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }`; `type:"result"` → `usage-metadata` (with `costUsd: msg.total_cost_usd` when present) then `done { summary: first 120 chars of msg.result }`, or `error { message }` when `msg.subtype` starts with `error`. Unknown message types are ignored (forward-compatible).
- `setPermissionMode(mode)`: call the query object's `setPermissionMode` when it exists; otherwise emit nothing and log once. `interrupt()`: call `interrupt()` when it exists. `kill()`: interrupt + close the send-queue + close the event queue.
- `handoffCommand()`: `` backendSessionId ? `claude --resume ${backendSessionId}` : null ``.
- **Vendor-API note applies:** exact SDK message field names are verified against the installed `@anthropic-ai/claude-agent-sdk` typings during implementation; adjust mapping internals, never the emitted `AgentEvent` shapes.

- [ ] **Step 1: Write the failing mocked test**

`packages/daemon/test/agents/claude.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@claurp/protocol";
import { ClaudeAdapter } from "../../src/agents/claude.js";
import { adapterContractSuite } from "../../src/agents/contract.js";

type CanUseTool = (tool: string, input: Record<string, unknown>) => Promise<unknown>;

function scriptedQueryFn(capture: { options?: Record<string, unknown> }) {
  return (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    capture.options = args.options;
    async function* gen() {
      yield { type: "system", subtype: "init", session_id: "sess-123" };
      const canUse = args.options.canUseTool as CanUseTool;
      const verdict = (await canUse("Bash", { command: "npm install" })) as { behavior: string };
      if (verdict.behavior === "allow") {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Installing." }, { type: "tool_use", name: "Bash", input: { command: "npm install" } }],
            usage: { input_tokens: 900, output_tokens: 40 },
          },
        };
      }
      yield { type: "result", subtype: "success", result: "All set.", total_cost_usd: 0.02 };
    }
    return Object.assign(gen(), { interrupt: async () => void 0, setPermissionMode: async () => void 0 });
  };
}

adapterContractSuite("claude(mocked)", () => new ClaudeAdapter({ queryFn: scriptedQueryFn({}) }));

describe("ClaudeAdapter mapping", () => {
  it("passes settingSources/cwd/mode and maps the message stream", async () => {
    const capture: { options?: Record<string, unknown> } = {};
    const a = new ClaudeAdapter({ queryFn: scriptedQueryFn(capture) });
    const s = a.spawn({ cwd: "/tmp/proj", prompt: "install deps", permissionMode: "default" });
    const seen: AgentEvent[] = [];
    for await (const e of s.events()) {
      seen.push(e);
      if (e.kind === "needs-permission") {
        expect(e.tool).toBe("Bash");
        expect(e.detail).toBe("npm install");
        s.respondPermission(e.requestId, "allow");
      }
      if (e.kind === "done") break;
    }
    expect(capture.options!.settingSources).toEqual(["user", "project", "local"]);
    expect(capture.options!.cwd).toBe("/tmp/proj");
    expect(capture.options!.permissionMode).toBe("default");
    expect(seen.map((e) => e.kind)).toEqual([
      "started", "needs-permission", "text-delta", "tool-use", "usage-metadata", "usage-metadata", "done",
    ]);
    expect(s.handoffCommand()).toBe("claude --resume sess-123");
    const done = seen.at(-1) as { kind: "done"; summary?: string };
    expect(done.summary).toBe("All set.");
  });

  it("deny path completes without the assistant turn", async () => {
    const a = new ClaudeAdapter({ queryFn: scriptedQueryFn({}) });
    const s = a.spawn({ cwd: "/tmp", prompt: "install", permissionMode: "default" });
    const seen: AgentEvent[] = [];
    for await (const e of s.events()) {
      seen.push(e);
      if (e.kind === "needs-permission") s.respondPermission(e.requestId, "deny");
      if (e.kind === "done" || e.kind === "error") break;
    }
    expect(seen.some((e) => e.kind === "text-delta")).toBe(false);
    expect(seen.at(-1)!.kind).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @claurp/daemon test -- claude.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement queue.ts move + claude.ts**

Move `EventQueue` to `agents/queue.ts` (export it; fix `fake.ts` imports). Implement `ClaudeAdapter` per the SDK-mapping contract, checking field names against the installed SDK typings (`node_modules/@anthropic-ai/claude-agent-sdk/…`) and adjusting internals only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- claude.test` and `pnpm --filter @claurp/daemon test -- fake`
Expected: contract suite ×2 + mapping tests all green (fake re-verified after the queue move).

- [ ] **Step 5: Add the env-gated real smoke test**

`packages/daemon/test/agents/claude.smoke.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../src/agents/claude.js";

describe.skipIf(process.env.CLAURP_REAL_CLAUDE !== "1")("ClaudeAdapter real smoke", () => {
  it("runs a trivial real session", async () => {
    const s = new ClaudeAdapter().spawn({
      cwd: mkdtempSync(join(tmpdir(), "claurp-smoke-")),
      prompt: "Reply with exactly the single word: pineapple",
      permissionMode: "default",
    });
    let text = "";
    for await (const e of s.events()) {
      if (e.kind === "text-delta") text += e.text;
      if (e.kind === "done" || e.kind === "error") break;
    }
    expect(text.toLowerCase()).toContain("pineapple");
  }, 300_000);
});
```

Run once manually: `CLAURP_REAL_CLAUDE=1 pnpm --filter @claurp/daemon test -- claude.smoke` (uses your logged-in Claude Code; verifies the SDK field-name assumptions against reality). Fix mapping internals if it disagrees with the mocked expectations.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(daemon): Claude Code adapter over Agent SDK with voice-permission callback (sdk vX.Y.Z)"
```

---

### Task 13: Meter service

**Files:**
- Create: `packages/daemon/src/meter.ts`
- Test: `packages/daemon/test/meter.test.ts`

**Interfaces:**
- Consumes: `claurpHome()`; `usage-metadata` events (fed by the server in Task 16).
- Produces:

```ts
export interface UsageSummary { inputTokens: number; outputTokens: number; costUsd: number; sessions: number }
export class MeterService {
  constructor(opts?: { now?: () => number });           // clock injection for tests
  record(sessionId: string, u: { inputTokens: number; outputTokens: number; costUsd?: number }): void;
  summary(period: "day" | "week"): UsageSummary;         // rolling 24h / 7d windows
  contextFill(sessionId: string, windowTokens?: number): number | null; // latest inputTokens / window (default 200_000); null if unseen
  persist(): void;                                       // append-only JSONL at ~/.claurp/usage.jsonl
  static load(opts?: { now?: () => number }): MeterService; // replays the JSONL
}
```

Honesty rule (spec §5.5): the meter reports **only what the daemon spawned and observed**. The narrator's phrasing for meta answers (Task 14) must say "across claurp sessions" — never imply account-level totals.

- [ ] **Step 1: Write the failing test**

`packages/daemon/test/meter.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MeterService } from "../src/meter.js";

beforeEach(() => { process.env.CLAURP_HOME = mkdtempSync(join(tmpdir(), "claurp-meter-")); });

describe("MeterService", () => {
  it("aggregates rolling windows with an injected clock", () => {
    let t = 0;
    const m = new MeterService({ now: () => t });
    m.record("s1", { inputTokens: 1000, outputTokens: 100, costUsd: 0.01 });
    t += 2 * 24 * 3600 * 1000;                                   // +2 days
    m.record("s2", { inputTokens: 500, outputTokens: 50 });
    expect(m.summary("day")).toEqual({ inputTokens: 500, outputTokens: 50, costUsd: 0, sessions: 1 });
    expect(m.summary("week")).toEqual({ inputTokens: 1500, outputTokens: 150, costUsd: 0.01, sessions: 2 });
  });

  it("computes context fill from the latest turn", () => {
    const m = new MeterService();
    m.record("s1", { inputTokens: 40_000, outputTokens: 10 });
    m.record("s1", { inputTokens: 80_000, outputTokens: 10 });
    expect(m.contextFill("s1")).toBeCloseTo(0.4);                // 80k / 200k
    expect(m.contextFill("nope")).toBeNull();
  });

  it("persists and reloads", () => {
    const m = new MeterService();
    m.record("s1", { inputTokens: 100, outputTokens: 10, costUsd: 0.002 });
    m.persist();
    const m2 = MeterService.load();
    expect(m2.summary("week").inputTokens).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @claurp/daemon test -- meter`
Expected: FAIL.

- [ ] **Step 3: Implement meter.ts**

In-memory array of `{ ts, sessionId, inputTokens, outputTokens, costUsd }`; `summary` filters by `now() - windowMs`; `sessions` counts distinct ids in-window; `persist` appends any un-persisted rows as JSONL; `load` replays the file (tolerating a missing file).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @claurp/daemon test -- meter`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(daemon): passive usage meter with rolling summaries and context fill"
```

---
### Task 14: Narrator (rule-based templates)

**Files:**
- Create: `packages/daemon/src/narrator.ts`
- Test: `packages/daemon/test/narrator.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` (T9), `UsageSummary` (T13).
- Produces:

```ts
export type Verbosity = "chatty" | "normal" | "quiet" | "silent";
export class Narrator {
  constructor(opts?: { verbosity?: Verbosity });        // default "normal"
  spawned(label: string): string | null;                 // "Starting auth refactor."
  onEvent(label: string, e: AgentEvent): string | null;  // speaking-rules table below
  permissionAsk(tool: string, detail: string): string;   // "Claude wants to run npm install — allow?"
  permissionDetail(detail: string): string;              // verbatim wrapper for "what exactly?"
  metaStatus(roster: Array<{ label: string; state: string }>): string;
  metaUsage(s: UsageSummary): string;                    // MUST include "across claurp sessions" (spec §5.5 honesty)
  metaContextFill(label: string, fill: number | null): string;
  captureUnavailable(target: "screen" | "camera"): string; // "Screen capture arrives in the next release." (honest degrade)
  handoff(cmd: string | null): string;
  modeChanged(label: string, mode: string): string;
  bypassConfirmNeeded(): string;                         // "Bypass turns off all permission checks — say 'confirm bypass'."
}
```

Speaking-rules table for `onEvent` (returns `null` = stay quiet):

| event \ verbosity | chatty | normal | quiet | silent |
|---|---|---|---|---|
| `tool-use` | "Running <tool>." | null | null | null |
| `needs-input` | verbatim `prompt` | verbatim `prompt` | verbatim `prompt` | null |
| `done` | "<label>: done. <summary>" | same | "<label>: done." | null |
| `error` | "<label> hit an error: <message>" | same | same | null |
| `started`, `text-delta`, `usage-metadata`, `needs-permission` | null (permission asks route through `permissionAsk`, driven by the policy engine, not `onEvent`) | null | null | null |

- [ ] **Step 1: Write the failing table-driven test** — `packages/daemon/test/narrator.test.ts` exercising every cell above plus: `spawned` returns null at `quiet`/`silent`; `metaUsage({inputTokens: 1500, outputTokens: 150, costUsd: 0.01, sessions: 2})` contains "across claurp sessions", "1,500" or "1500", and "2 sessions"; `metaContextFill("auth refactor", 0.4)` contains "40"; `metaContextFill("x", null)` says it has no data; `captureUnavailable("screen")` mentions "next release"; `permissionAsk("Bash", "npm install")` equals `"Claude wants to run npm install — allow?"`; `bypassConfirmNeeded()` contains "confirm bypass". Write the expected strings into the test first; they are the product copy.
- [ ] **Step 2: Run to verify FAIL** — `pnpm --filter @claurp/daemon test -- narrator`
- [ ] **Step 3: Implement `narrator.ts`** — pure functions over the tables; no I/O, no timers.
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): rule-based narrator with verbosity dial"`

---

### Task 15: TTS (sentence splitter + Kokoro)

**Files:**
- Create: `packages/daemon/src/tts/sentences.ts`, `packages/daemon/src/tts/kokoro.ts`
- Test: `packages/daemon/test/tts/sentences.test.ts`, `packages/daemon/test/tts/kokoro.test.ts`
- Modify: `packages/daemon/package.json` (add `kokoro-js` — `pnpm --filter @claurp/daemon add kokoro-js@latest`, record version)

**Interfaces:**
- Consumes: nothing internal.
- Produces:

```ts
// sentences.ts
export class SentenceSplitter {
  push(chunk: string): string[];   // returns any sentences completed by this chunk (split after . ! ? followed by space/end)
  flush(): string | null;          // remaining tail, trimmed; null if empty
}
// kokoro.ts
export interface TtsEngine {
  synthesize(text: string): AsyncIterable<Int16Array>; // 24 kHz mono PCM16, ~200 ms chunks (4800 samples)
  stop(): void;                                        // abort between chunks (barge-in)
}
export function createKokoroTts(opts?: { voice?: string }): Promise<TtsEngine>; // default voice "af_heart"
```

- [ ] **Step 1: Write the failing splitter test** — cases: `push("Hello. Wor") → ["Hello."]` then `push("ld! And") → ["World!"]` then `flush() → "And"`; abbreviations are NOT protected in v0.1 (document with a test asserting `push("e.g. run it. ") → ["e.g.", "run it."]` — acceptable for narrator copy, which avoids abbreviations); empty flush → null.
- [ ] **Step 2: Run FAIL, implement `sentences.ts` (a ~30-line buffer + regex `/([.!?])(\s+|$)/`), run PASS.**
- [ ] **Step 3: Write the failing Kokoro test** — `packages/daemon/test/tts/kokoro.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createKokoroTts } from "../../src/tts/kokoro.js";

describe.skipIf(process.env.CLAURP_SKIP_TTS === "1")("kokoro tts", () => {
  it("synthesizes audible PCM for a short line", async () => {
    const tts = await createKokoroTts();
    let samples = 0, peak = 0;
    for await (const chunk of tts.synthesize("claurp is ready.")) {
      samples += chunk.length;
      for (const s of chunk) peak = Math.max(peak, Math.abs(s));
    }
    expect(samples).toBeGreaterThan(8000);   // > 1/3 s at 24 kHz
    expect(peak).toBeGreaterThan(500);       // not silence
  }, 600_000);
});
```

First run downloads the q8 model (~90 MB) — set `process.env.HF_HOME = join(claurpHome(), "models", "hf")` inside `createKokoroTts` *before* the dynamic `import("kokoro-js")` so the cache lands under `~/.claurp`. Vendor-API note applies: expected surface is `KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8" })` then `await tts.generate(text, { voice })` → `{ audio: Float32Array; sampling_rate: 24000 }`; verify against the installed README, adapt internals only. Convert float32 → int16 with clamping and yield in 4800-sample slices; check an `aborted` flag between slices for `stop()`.

- [ ] **Step 4: Run FAIL, implement `kokoro.ts`, run PASS** (`pnpm --filter @claurp/daemon test -- tts`).
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): kokoro TTS engine with sentence streaming (kokoro-js vX.Y.Z)"`

---

### Task 16: Daemon server wiring + CLI + demo client

**Files:**
- Create: `packages/daemon/src/server.ts` (orchestration; split a `server-dispatch.ts` out if it nears 500 lines), `packages/daemon/src/cli.ts`, `packages/daemon/tools/demo.ts`
- Test: `packages/daemon/test/server.test.ts` (fast, seams), `packages/daemon/test/e2e.test.ts` (heavy, model-gated)

**Interfaces:**
- Consumes: everything: protocol messages (T1), `AudioPipeline` + `PipelineEvent` (T7), `parseIntent` (T8), adapters (T9/T12), `SessionManager` + `loadProjects` (T10), `PermissionPolicy` (T11), `MeterService` (T13), `Narrator` (T14), `SentenceSplitter`/`TtsEngine` (T15).
- Produces:

```ts
export interface PipelineLike { feed(f: Int16Array): Promise<void>; pttDown(): void; pttUp(): Promise<void> }
export interface DaemonDeps {
  pipelineFactory: (onEvent: (e: PipelineEvent) => void) => Promise<PipelineLike>; // test seam
  adapters: Map<string, AgentAdapter>;
  defaultAdapter: string;
  projects: { defaultProject: Project; byName: Map<string, Project> };
  policy: PermissionPolicy;
  meter: MeterService;
  narrator: Narrator;
  tts: TtsEngine;
}
export class DaemonServer {
  constructor(deps: DaemonDeps, opts?: { port?: number });  // port 0 = ephemeral
  start(): Promise<number>;                                  // resolves with the bound port
  stop(): Promise<void>;
}
```

**Dispatch contract (the whole product in one table — implement exactly):**

1. WS connect → first message must be `hello` (else close 4000) → reply `hello.ack` + `state:idle`.
2. Binary `BIN_MIC_PCM16_16K` → accumulate, slice into 512-sample frames (carry the remainder), `pipeline.feed` each.
3. `PipelineEvent` handling: `wake` → send `earcon:wake-ack`, `state:listening`, `speak.stop`, `tts.stop()`; `partial` → `transcript.partial`; `final` → `transcript.final` then dispatch `parseIntent(text)`:
   - `prompt`: if the intent carries `project`, resolve via `projects.byName` (unknown name → speak "No project named <name>." and stop). With a named project, or with no focused session in state `working`/`needs-input`, spawn on the default adapter (named project or `defaultProject`) and speak `narrator.spawned(label)`; otherwise `handle.send([{type:"text",text}])` to the focused session.
   - `session/new` → always spawn with the captured prompt (same `project` resolution rule).
   - `session/status` and `meta/status` → speak `narrator.metaStatus(roster)`.
   - `session/switch` → `switchTo(target)`; speak "Focused on <label>." or "No session matching <target>."
   - `session/kill` → kill focused; speak "<label> stopped."
   - `session/handoff` → `cmd = manager.handoff(focusedId)`; if non-null run `osascript -e 'tell application "Terminal" to do script "<cmd>"' -e 'tell application "Terminal" to activate'` (single-quote-escape the cmd) and speak `narrator.handoff(cmd)`; if null speak the honest refusal.
   - `permission/*`: no pending ask on the focused session → speak "Nothing is waiting on permission."; `allow`/`deny` → `manager.respondPermission`; `always` → `policy.recordAlways(pending.tool, pending.detail)`; if it returns false speak "That one can't be always-allowed." and leave the ask pending, else respond allow; `detail` → speak `narrator.permissionDetail(pending.detail)` and leave pending.
   - `mode`: `confirmed:false` (bypass) → speak `narrator.bypassConfirmNeeded()`; confirmed → `manager.setPermissionMode(focusedId, mode)` + speak `narrator.modeChanged(label, mode)`.
   - `meta/usage` → `narrator.metaUsage(meter.summary("week"))`; `meta/contextFill` → `narrator.metaContextFill(label, meter.contextFill(focusedId))`.
   - `capture` → speak `narrator.captureUnavailable(target)`.
4. Session event pump — on every spawn, start `for await (const e of handle.events())`: `manager.noteActivity` + `manager.consume(id, e)`; `usage-metadata` → `meter.record(id, e)`; **`needs-permission` → `policy.decide(e.tool, e.detail)` FIRST**: `auto-allow` → `handle.respondPermission(e.requestId, "allow")` silently and revert state; `ask` → send `hud.permission`, `notify` (actions `["allow","deny"]`), `earcon:permission-ask`, `state:needs-you`, speak `narrator.permissionAsk(e.tool, e.detail)`; `done` → `earcon:done` + `notify` ("<label> done", action `open-terminal` when `handoffCommand()` is non-null); `error` → `notify` + speak. Every `manager.onChange` → send `hud.session` (include latest narration line). After the pump ends, `meter.persist()`; recompute `state` (`idle` when nothing working/needs-you).
5. `speak(text)`: run through `SentenceSplitter`; for each sentence, stream `tts.synthesize(sentence)` chunks as `BIN_TTS_PCM16_24K` frames; a `wake` or `speak.stop` cause aborts mid-stream (`tts.stop()`).
6. WS `permission.response` (HUD buttons) → same path as voice `permission/allow|deny`. WS `ptt` → `pipeline.pttDown/pttUp`.
7. Multiple senses clients may connect (e.g. demo + real app): broadcast daemon→senses messages to all; accept mic/ptt only from the first (log a warning otherwise).
8. Watchdog (spec §3): `ws`-level ping every 5 s to each client; terminate a client that misses 3 pongs (the `ws` library answers pings automatically on the client side, so the future Swift helper only needs standard pong behavior).

- [ ] **Step 1: Write the failing server test (fast seams)** — `packages/daemon/test/server.test.ts`: build `DaemonServer` with `pipelineFactory` that captures `onEvent` into a test-controlled variable and returns a stub; `FakeAgent` as `"fake"` default adapter; real `Narrator`/`PermissionPolicy`/`MeterService` (tmp `CLAURP_HOME`); stub `TtsEngine` yielding one 100-sample chunk. Connect a real `ws` client to the ephemeral port. Assertions, in order: (a) `hello` → `hello.ack` then `state:idle`; (b) inject `{kind:"final", text:"create a file called notes.txt"}` → observe `hud.session` (spawning→working), then `hud.permission` with tool `Write`, `notify` with actions, `earcon:permission-ask`, `state:needs-you`, and ≥1 binary TTS frame; (c) send `permission.response allow` → observe `hud.session` reaching `done`, `notify` done, `earcon:done`, `state:idle`; (d) inject `{kind:"final", text:"usage"}` → a TTS frame arrives and **no new session appears in a subsequent `status` narration**; (e) inject final `"look at my screen"` → TTS frame, no crash; (f) inject `wake` while a TTS stream is mid-flight → `speak.stop` observed. Collect WS messages into an array with a `waitFor(predicate)` helper (poll + timeout) — no sleeps.
- [ ] **Step 2: Run FAIL** — `pnpm --filter @claurp/daemon test -- server`
- [ ] **Step 3: Implement `server.ts` + `cli.ts`** — `cli.ts`: parse `--port` (default 8765) and `--adapter` (default `claude`; `fake` supported for demos), `loadProjects()`, build real pipeline components (Tasks 3–6) via a production `pipelineFactory`, `MeterService.load()`, register both adapters, `start()`, log `claurp-daemon listening on ws://127.0.0.1:<port>`, graceful SIGINT (`stop()` + `meter.persist()`).
- [ ] **Step 4: Run PASS** — full unit suite: `pnpm --filter @claurp/daemon test` (heavy tests skip without models; run them locally where models exist).
- [ ] **Step 5: Write `tools/demo.ts` + heavy e2e test** — `demo.ts`: starts `DaemonServer` (flags `--adapter fake|claude`), connects as a fake senses client, streams `silence(1s) + hey_claude_create_file.wav + silence(3s)` as mic frames in real-time-ish 32 ms ticks, prints every JSON message received, answers the first `hud.permission` by sending `permission.response allow` after 2 s, and writes all received TTS frames to `demo-out.wav` (24 kHz) so you can `afplay` the daemon's voice. Add script `"demo": "tsx tools/demo.ts"`. `test/e2e.test.ts` automates exactly that flow against `FakeAgent` (model-gated with `describe.skipIf`, generous timeout), asserting: a `transcript.final` containing "haiku", a `hud.permission` for `Write`, and after the allow a `notify` whose title contains "done".
- [ ] **Step 6: Run the demo by hand** — `pnpm --filter @claurp/daemon demo` (fake), then the real thing: `pnpm --filter @claurp/daemon demo -- --adapter claude` with your logged-in Claude Code. Listen to `demo-out.wav`. This is the Plan-1 finish line.
- [ ] **Step 7: Commit** — `git commit -am "feat(daemon): WS server orchestration, CLI entry, demo client and e2e test"`

---

## Out of scope for this plan (tracked)

- Swift senses app (mic, HUD, notifications, hotkey, playback): **Plan 2**, against the protocol frozen here.
- `npx claurp` first-run setup, bundled whisper binary, CI matrix, packaging/signing: **Plan 3**.
- Screen/ink, camera, Codex/Gemini adapters, Apple-FM narrator: v0.2/v0.3 per spec §10 (the router and narrator already answer capture verbs honestly).

