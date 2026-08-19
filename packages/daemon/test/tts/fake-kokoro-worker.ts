// Fake worker for kokoro-stop.test.ts. Speaks the exact same IPC protocol as
// the real src/tts/kokoro-worker.ts (see that file's header for the message
// shapes) but never touches kokoro-js/onnxruntime/the network — it emits many
// dummy Int16Array chunks, yielding via setImmediate between each (mirroring
// the real worker's own per-chunk yield exactly). CHUNK_COUNT is deliberately
// large (not a realistic utterance size): the real bug this guards against
// only manifests when the worker can get well AHEAD of the consumer — i.e. a
// genuine backlog piles up in the parent's channel before stop() runs. A
// small chunk count paced this way finishes (sends "done") faster than any
// consumer can realistically react, which would make a stop()-mid-stream test
// flaky/meaningless; a large count guarantees a comfortable real-time window
// where the stream is genuinely still in progress when stop() is called.
const CHUNK_COUNT = 2000;
const CHUNK_SAMPLES = 100;

type ParentMessage = { type: "synthesize"; id: number; text: string; voice: string } | { type: "abort"; id: number };

const abortedIds = new Set<number>();

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function handleSynthesize(id: number): Promise<void> {
  let aborted = false;
  for (let i = 0; i < CHUNK_COUNT; i++) {
    if (abortedIds.has(id)) {
      aborted = true;
      break;
    }
    const chunk = new Int16Array(CHUNK_SAMPLES).fill(1000 + i); // distinguishable, non-silent dummy data
    process.send?.({ type: "chunk", id, pcm: chunk });
    await yieldToEventLoop();
  }
  abortedIds.delete(id);
  if (!aborted) process.send?.({ type: "done", id });
}

process.on("message", (raw: ParentMessage) => {
  if (raw.type === "abort") {
    abortedIds.add(raw.id);
    return;
  }
  void handleSynthesize(raw.id);
});

process.send?.({ type: "ready" }); // no model to load — ready immediately
