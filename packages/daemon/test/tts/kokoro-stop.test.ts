import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKokoroTts } from "../../src/tts/kokoro.js";

// Uses a fake worker (same IPC protocol, no real model — see fake-kokoro-worker.ts)
// so this runs in milliseconds and exercises the exact bug found during manual
// verification: stop() must (a) stop the async iterator promptly and (b) not
// deliver chunks the worker had already sent-but-buffered before stop() ran.
//
// Calibrated empirically (see task-15-report.md's fix addendum): the fake
// worker's 2000 chunks complete in ~37ms total, with the 2nd chunk arriving
// in ~1ms. A 15ms sleep between receiving chunk 2 and calling stop() sits
// comfortably inside that window — long enough that a genuine backlog reliably
// piles up in the parent's channel (hundreds of chunks, confirmed by running
// this exact scenario against a deliberately-reverted `abort()` that doesn't
// clear the queue: 738 chunks leaked through, vs. exactly 2 with the fix) —
// while remaining safely short of the worker's natural completion, so this is
// a genuine mid-stream stop(), not a race against "done" already having fired.
const FAKE_WORKER = join(import.meta.dirname, "fake-kokoro-worker.ts");
const BACKLOG_BUILD_MS = 15;

describe("KokoroTts stop() (barge-in)", () => {
  it("stops yielding promptly and drops chunks already buffered when stop() is called", async () => {
    const tts = await createKokoroTts({ workerEntry: FAKE_WORKER });
    const received: Int16Array[] = [];
    try {
      for await (const chunk of tts.synthesize("text is irrelevant to the fake worker")) {
        received.push(chunk);
        if (received.length === 2) {
          await new Promise((resolve) => setTimeout(resolve, BACKLOG_BUILD_MS));
          tts.stop();
        }
      }
    } finally {
      tts.dispose();
    }
    // Exactly the 2 chunks consumed before stop() — none of the (likely
    // hundreds of) further chunks the worker already sent and buffered while
    // we were asleep. See the module comment for the pre-fix comparison.
    expect(received.length).toBe(2);
  });

  it("dispose() is idempotent and safe to call without an active synthesize()", async () => {
    const tts = await createKokoroTts({ workerEntry: FAKE_WORKER });
    tts.dispose();
    expect(() => tts.dispose()).not.toThrow();
  });
});
