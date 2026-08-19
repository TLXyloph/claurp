import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface TtsEngine {
  synthesize(text: string): AsyncIterable<Int16Array>; // 24 kHz mono PCM16, ~200 ms chunks (4800 samples)
  stop(): void; // abort between chunks (barge-in)
}

// Messages exchanged with kokoro-worker.ts over the child's IPC channel. See that
// file's header comment for why IPC (not stdio) carries the audio.
type WorkerToParent =
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | { type: "chunk"; id: number; pcm: Int16Array }
  | { type: "done"; id: number }
  | { type: "error"; id: number; message: string };
type ParentToWorker = { type: "synthesize"; id: number; text: string; voice: string } | { type: "abort"; id: number };

// A tiny single-producer/single-consumer async channel: onMessage() push()es
// values from the child's "message" event; the generator loop pulls them via
// iterator.next(). Lets synthesize() `for await` cleanly instead of hand-rolling
// event-listener bookkeeping inline.
//
// finish() vs abort(): finish() is the natural "done"/"error" close — anything
// already buffered in `queue` is still real synthesized audio and gets drained
// to the caller. abort() (stop()'s barge-in path) additionally discards
// `queue` — the worker can enqueue several chunks for one already-computed
// utterance faster than a caller consumes them (generate() returns the whole
// utterance in one call, not incrementally), so by the time stop() runs,
// already-buffered-but-unplayed chunks may exist and must NOT still play.
function createChannel<T>() {
  const queue: T[] = [];
  let waiting: ((r: IteratorResult<T>) => void) | null = null;
  let closed = false;
  let closeErr: unknown;

  function push(item: T): void {
    if (closed) return;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: item, done: false });
    } else {
      queue.push(item);
    }
  }
  function settleClosed(): void {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      // The IteratorResult "value" field is unused on the done branch by any
      // caller here; `next()` checks closeErr itself before reading .value.
      resolve({ value: undefined as T, done: true });
    }
  }
  function finish(err?: unknown): void {
    if (closed) return;
    closed = true;
    closeErr = err;
    settleClosed();
  }
  function abort(): void {
    if (closed) return;
    closed = true;
    queue.length = 0; // drop anything buffered-but-unyielded — see header comment
    settleClosed();
  }
  const iterator = {
    next(): Promise<IteratorResult<T>> {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift() as T, done: false });
      if (closed) return closeErr !== undefined ? Promise.reject(closeErr) : Promise.resolve({ value: undefined as T, done: true });
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
  };
  return { push, finish, abort, iterator };
}

// The worker is always run from its TypeScript source via `tsx`'s Node loader
// hook, in both dev/test (kokoro.ts itself running unbuilt from src/) and
// production (kokoro.ts running built from dist/) — this keeps a single code
// path and needs no separate "did the build run" branching. `tsx` is a regular
// dependency for this reason (see package.json note). The source path is
// resolved via the package root (found through package.json), NOT relative to
// this file's own location — resolving "./kokoro-worker.ts" relative to
// import.meta.url would land in dist/tts/ when kokoro.ts runs built, where
// only kokoro-worker.js exists.
//
// Deliberately `fork(workerSrc.ts, [], { execArgv: ["--import", "tsx"] })`
// rather than `fork(require.resolve("tsx/cli"), [workerSrc])` (i.e. NOT
// through tsx's own CLI binary). Verified empirically: tsx's CLI internally
// does its own `child_process.spawn()` to a *second*, nested Node process to
// actually run the target script, rather than transforming it in-place. That
// nested process still gets a working `process.send` (the fd is inherited),
// but it silently loses the `serialization: "advanced"` mode requested on our
// fork() call — chunk messages arrive as plain `{ "0": ..., "1": ... }`
// objects instead of real Int16Array instances (confirmed with a minimal
// isolated repro before landing this). Using Node's own `--import` loader
// hook keeps the worker in the single process fork() actually creates, so the
// advanced-serialization channel it establishes reaches the real worker code
// directly — confirmed via the same repro (Int16Array survives intact).
function resolveWorkerEntry(): { workerSrc: string; cwd: string } {
  const require = createRequire(import.meta.url);
  const pkgRoot = dirname(require.resolve("../../package.json"));
  const workerSrc = join(pkgRoot, "src", "tts", "kokoro-worker.ts");
  return { workerSrc, cwd: pkgRoot };
}

function spawnWorker(): ChildProcess {
  const { workerSrc, cwd } = resolveWorkerEntry();
  return fork(workerSrc, [], {
    cwd,
    execArgv: ["--import", "tsx"], // registers tsx's TS-loader hook in this same process, no nested spawn
    serialization: "advanced", // required to pass Int16Array chunks without JSON round-tripping
    stdio: ["ignore", "ignore", "inherit", "ipc"], // stderr inherited for visibility; stdout unused (see kokoro-worker.ts header)
  });
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (msg: WorkerToParent): void => {
      if (msg.type === "ready") {
        cleanup();
        resolve();
      } else if (msg.type === "fatal") {
        cleanup();
        reject(new Error(`kokoro worker failed to initialize: ${msg.message}`));
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`kokoro worker exited before becoming ready (code ${code})`));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    function cleanup(): void {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export async function createKokoroTts(opts: { voice?: string } = {}): Promise<TtsEngine> {
  const voice = opts.voice ?? "af_heart";
  const child = spawnWorker();
  await waitForReady(child);

  let nextId = 1;
  let activeId: number | null = null;
  const activeChannels = new Map<number, ReturnType<typeof createChannel<Int16Array>>>();

  const onMessage = (msg: WorkerToParent): void => {
    if (msg.type === "ready" || msg.type === "fatal") return; // init-phase only, already handled
    const chan = activeChannels.get(msg.id);
    if (!chan) return; // stopped/finished already; drop late messages
    if (msg.type === "chunk") chan.push(msg.pcm);
    else if (msg.type === "done") chan.finish();
    else if (msg.type === "error") chan.finish(new Error(msg.message));
  };
  child.on("message", onMessage);
  child.on("exit", (code) => {
    const err = new Error(`kokoro worker exited unexpectedly (code ${code})`);
    for (const chan of activeChannels.values()) chan.finish(err);
  });

  async function* synthesize(text: string): AsyncIterable<Int16Array> {
    const id = nextId++;
    activeId = id;
    const chan = createChannel<Int16Array>();
    activeChannels.set(id, chan);
    const req: ParentToWorker = { type: "synthesize", id, text, voice };
    child.send(req);
    try {
      for (;;) {
        const { value, done } = await chan.iterator.next();
        if (done) return;
        yield value;
      }
    } finally {
      activeChannels.delete(id);
      if (activeId === id) activeId = null;
    }
  }

  function stop(): void {
    if (activeId === null) return;
    const id = activeId;
    const req: ParentToWorker = { type: "abort", id };
    child.send(req);
    activeChannels.get(id)?.abort(); // stop yielding immediately, discarding anything already buffered
  }

  return { synthesize, stop };
}
