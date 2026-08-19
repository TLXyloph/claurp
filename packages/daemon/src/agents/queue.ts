import type { AgentEvent } from "@claurp/protocol";

/**
 * Internal push-queue backing `SessionHandle.events()`. An async iterator
 * drains events as they are pushed and closes automatically after a
 * terminal `done`/`error` event (or an explicit `close()`, e.g. on `kill()`).
 */
export class EventQueue {
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
