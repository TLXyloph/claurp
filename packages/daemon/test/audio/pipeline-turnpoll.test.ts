// Pins the controller-ruled fix-round behavior: the turn detector must be polled on every
// 13-frame trailing-quiet multiple (13, 26, 39, ...), not consulted once at frame 13 and then
// abandoned until the 78-frame fallback. pipeline.test.ts and pipeline.integration.test.ts are
// frozen, so this regression is pinned in its own file instead of editing either of them.
import { describe, expect, it } from "vitest";
import { AudioPipeline, type PipelineEvent } from "../../src/audio/pipeline.js";

const FRAME = 512;
function speechFrame(): Int16Array { return new Int16Array(FRAME).fill(1000); }
function quietFrame(): Int16Array { return new Int16Array(FRAME); }

describe("audio pipeline turn-detector polling", () => {
  it("polls turn.isComplete on every 13-frame trailing-quiet multiple, finalizing on the first true", async () => {
    let turnCalls = 0;
    let fed = 0;
    const fakes = {
      vad: { isSpeech: (f: Float32Array) => f.some((s) => s !== 0), reset: () => void 0 },
      wake: { feed: () => (++fed === 3 ? "HEY_CLAUDE" : null), reset: () => void 0 },
      transcriber: {
        start: async () => void 0,
        stop: async () => void 0,
        transcribe: async (pcm: Int16Array) => `hey claude, transcript of ${Math.round(pcm.length / FRAME)} frames`,
      },
      turn: {
        // wake hits at feed #3 -> buffer is 8 frames once the speech loop below ends (frames
        // 3..10 inclusive, hit frame included). Trailing-quiet consult #1 (13th quiet frame)
        // sees buffer=8+13=21 frames; consult #2 (26th quiet frame) sees buffer=8+26=34 frames.
        // Threshold 30 is reachable only on the SECOND consult, not the first.
        isComplete: async (pcm: Float32Array) => {
          turnCalls++;
          return pcm.length / FRAME >= 30;
        },
      },
    };

    const events: PipelineEvent[] = [];
    const p = new AudioPipeline(fakes, (e) => events.push(e));

    for (let i = 0; i < 10; i++) await p.feed(speechFrame()); // wake fires at frame 3
    for (let i = 0; i < 30; i++) await p.feed(quietFrame());  // trailing quiet: polls at 13 and 26

    expect(events.some((e) => e.kind === "wake")).toBe(true);
    // Pins the polling behavior itself: single-shot would only ever call this once.
    expect(turnCalls).toBeGreaterThan(1);
    expect(turnCalls).toBe(2); // exactly the frame-13 (false) and frame-26 (true) consults

    const final = events.at(-1)!;
    expect(final.kind).toBe("final");
    // Finalized right at the frame-26 consult (buffer=34 frames) — well before the 78-frame
    // fallback would have fired (which would show ~86 frames: 8 + 78).
    expect((final as { text: string }).text).toContain("34 frames");
  });
});
