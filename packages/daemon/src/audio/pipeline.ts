import type { VadGate } from "./vad.js";
import type { WakeSpotter } from "./wake.js";
import type { Transcriber } from "./transcriber.js";
import type { TurnDetector } from "./turn.js";
import { concatInt16, int16ToFloat32 } from "./pcm.js";

export type PipelineEvent =
  | { kind: "wake" }
  | { kind: "partial"; text: string }
  | { kind: "final"; text: string };

export interface AudioPipelineDeps {
  vad: VadGate;
  wake: WakeSpotter;
  transcriber: Transcriber;
  turn: TurnDetector;
}

type State = "idle" | "listening";

// Frame-count constants (512 samples @ 16 kHz = 32 ms/frame — see task-7-brief.md's behavior
// table for the derivations; ms figures below are approximate).
const HANGOVER_FRAMES = 15; // ~480ms: keep feeding the wake spotter this long past the last speech frame
const PARTIAL_EVERY_FRAMES = 25; // ~800ms cadence between partial transcriptions
const PARTIAL_MIN_BUFFER_FRAMES = 38; // ~1.2s minimum buffered before the first partial
const TURN_CHECK_FRAMES = 13; // ~400ms trailing quiet before consulting the turn detector
const SILENCE_FALLBACK_FRAMES = 78; // ~2.5s trailing quiet: finalize regardless of the turn detector
const HARD_CUTOFF_FRAMES = 3750; // ~120s listening: hard finalize safety valve

const WAKE_PHRASE_RE = /^\s*(hey[,.\s]+claude[,.!?\s]*)/i;

export class AudioPipeline {
  private readonly vad: VadGate;
  private readonly wake: WakeSpotter;
  private readonly transcriber: Transcriber;
  private readonly turn: TurnDetector;
  private readonly onEvent: (e: PipelineEvent) => void;

  private state: State = "idle";
  private buffer: Int16Array[] = [];
  private framesSinceWake = 0;
  private framesSincePartial = 0;
  private trailingQuiet = 0;
  private idleHangover = 0;
  // Rolling pre-speech lookback, flushed to the wake spotter the moment feeding resumes after
  // a quiet stretch — see task-7-report.md ("wake spotter needs pre-speech context"): the real
  // spotter reliably misses a keyword that leads its very first fed frame with no lead-in.
  private preRoll: Float32Array[] = [];
  private wasFeedingWake = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: AudioPipelineDeps, onEvent: (e: PipelineEvent) => void) {
    this.vad = deps.vad;
    this.wake = deps.wake;
    this.transcriber = deps.transcriber;
    this.turn = deps.turn;
    this.onEvent = onEvent;
  }

  // 512 samples @16k; serialized internally via a promise chain so overlapping feed() calls
  // (and pttUp()'s forced finalize) process in strict arrival order.
  feed(frame: Int16Array): Promise<void> {
    this.queue = this.queue.then(() => this.process(frame));
    return this.queue;
  }

  // Synchronous by interface (no frame in flight to serialize against) — a no-op unless idle.
  pttDown(): void {
    if (this.state !== "idle") return;
    this.state = "listening";
    this.buffer = [];
    this.framesSinceWake = 0;
    this.framesSincePartial = 0;
    this.trailingQuiet = 0;
  }

  pttUp(): Promise<void> {
    this.queue = this.queue.then(() => this.finalize());
    return this.queue;
  }

  private async process(frame: Int16Array): Promise<void> {
    const f32 = int16ToFloat32(frame);
    const speech = this.vad.isSpeech(f32); // computed once; reused for wake gating + trailing-quiet
    if (this.state === "idle") await this.processIdle(f32, speech, frame);
    else await this.processListening(frame, speech);
  }

  private async processIdle(f32: Float32Array, speech: boolean, frame: Int16Array): Promise<void> {
    if (speech) this.idleHangover = HANGOVER_FRAMES;
    const feedWake = speech || this.idleHangover > 0;
    if (!speech && this.idleHangover > 0) this.idleHangover--;

    if (!feedWake) {
      this.wasFeedingWake = false;
      this.preRoll.push(f32);
      if (this.preRoll.length > HANGOVER_FRAMES) this.preRoll.shift();
      return;
    }

    let hit: string | null = null;
    if (!this.wasFeedingWake) {
      // Resuming after a quiet stretch: give the spotter its lead-in before the live frame.
      for (const pf of this.preRoll) {
        if (hit) break;
        hit = this.wake.feed(pf);
      }
      this.preRoll = [];
    }
    this.wasFeedingWake = true;
    if (!hit) hit = this.wake.feed(f32);
    if (!hit) return;

    this.onEvent({ kind: "wake" });
    this.state = "listening";
    this.buffer = [];
    this.framesSinceWake = 0;
    this.framesSincePartial = 0;
    this.trailingQuiet = 0;
    this.wasFeedingWake = false;
    this.preRoll = [];
    // The command follows the wake phrase in the same breath: buffering starts at the hit,
    // so the triggering frame is itself the first one appended, via a reentrant listening step.
    await this.processListening(frame, speech);
  }

  private async processListening(frame: Int16Array, speech: boolean): Promise<void> {
    this.buffer.push(frame);
    this.framesSinceWake++;
    this.framesSincePartial++;
    this.trailingQuiet = speech ? 0 : this.trailingQuiet + 1;

    if (this.framesSincePartial >= PARTIAL_EVERY_FRAMES) {
      this.framesSincePartial = 0;
      if (this.buffer.length >= PARTIAL_MIN_BUFFER_FRAMES) {
        const text = await this.transcriber.transcribe(concatInt16(this.buffer));
        this.onEvent({ kind: "partial", text });
      }
    }

    // Single consult right as the trailing quiet run crosses the minimum-pause floor (not a
    // repeated per-frame poll all the way to the fallback — see task-7-report.md).
    if (this.trailingQuiet === TURN_CHECK_FRAMES) {
      const pcm = int16ToFloat32(concatInt16(this.buffer));
      if (await this.turn.isComplete(pcm)) {
        await this.finalize();
        return;
      }
    }
    if (this.trailingQuiet >= SILENCE_FALLBACK_FRAMES) {
      await this.finalize();
      return;
    }
    if (this.framesSinceWake >= HARD_CUTOFF_FRAMES) {
      await this.finalize();
      return;
    }
  }

  private async finalize(): Promise<void> {
    if (this.state !== "listening") return;
    const raw = await this.transcriber.transcribe(concatInt16(this.buffer));
    const text = raw.replace(WAKE_PHRASE_RE, "").trim();
    if (text.length > 0) this.onEvent({ kind: "final", text });

    this.vad.reset();
    this.wake.reset();
    this.state = "idle";
    this.buffer = [];
    this.framesSinceWake = 0;
    this.framesSincePartial = 0;
    this.trailingQuiet = 0;
    this.idleHangover = 0;
    this.preRoll = [];
    this.wasFeedingWake = false;
  }
}
