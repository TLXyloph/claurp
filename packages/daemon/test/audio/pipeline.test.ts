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
