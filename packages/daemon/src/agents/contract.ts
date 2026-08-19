import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentEvent } from "@claurp/protocol";

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), ms);
    }),
  ]);
}

/** Resolves `true` if `p` settles within `ms`, `false` if it is still pending. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  const pending = Symbol("pending");
  const winner = await Promise.race([
    p.then(() => "settled" as const),
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);
  return winner !== pending;
}

/**
 * Shared vitest contract suite for any `AgentAdapter` implementation.
 * Reused by the FakeAgent tests (Task 9) and the Claude adapter tests
 * (Task 12) against a mocked backend.
 */
export function adapterContractSuite(label: string, make: () => AgentAdapter): void {
  describe(`adapter contract: ${label}`, () => {
    it("first event is 'started'", async () => {
      const session = make().spawn({ cwd: "/tmp", prompt: "hello", permissionMode: "default" });
      const iter = session.events()[Symbol.asyncIterator]();
      const first = await withTimeout(iter.next(), 5000, "first event");
      expect(first.done).toBe(false);
      expect(!first.done && first.value.kind).toBe("started");
      session.kill();
    });

    it("needs-permission blocks the stream until respondPermission('allow') is called, then reaches done", async () => {
      const session = make().spawn({ cwd: "/tmp", prompt: "please write a file", permissionMode: "default" });
      const iter = session.events()[Symbol.asyncIterator]();

      let requestId: string | null = null;
      let last: AgentEvent | undefined;
      for (;;) {
        const r = await withTimeout(iter.next(), 5000, "event before needs-permission/done");
        if (r.done) break;
        last = r.value;
        if (last.kind === "needs-permission") { requestId = last.requestId; break; }
        if (last.kind === "done" || last.kind === "error") break;
      }

      if (requestId === null) {
        // This adapter's default scenario never asked for permission; nothing more to assert here.
        session.kill();
        return;
      }

      const pending = iter.next();
      expect(await settlesWithin(pending, 200)).toBe(false);

      session.respondPermission(requestId, "allow");
      const resumed = await withTimeout(pending, 5000, "event after respondPermission(allow)");
      expect(resumed.done).toBe(false);
      last = resumed.done ? last : resumed.value;

      while (last && last.kind !== "done" && last.kind !== "error") {
        const r = await withTimeout(iter.next(), 5000, "draining to done after allow");
        if (r.done) break;
        last = r.value;
      }
      expect(last?.kind).toBe("done");
    });

    it("needs-permission + respondPermission('deny') reaches done, not error", async () => {
      const session = make().spawn({ cwd: "/tmp", prompt: "please write a file", permissionMode: "default" });
      const iter = session.events()[Symbol.asyncIterator]();

      let requestId: string | null = null;
      let last: AgentEvent | undefined;
      for (;;) {
        const r = await withTimeout(iter.next(), 5000, "event before needs-permission/done");
        if (r.done) break;
        last = r.value;
        if (last.kind === "needs-permission") { requestId = last.requestId; break; }
        if (last.kind === "done" || last.kind === "error") break;
      }

      if (requestId === null) {
        session.kill();
        return;
      }

      session.respondPermission(requestId, "deny");
      while (last && last.kind !== "done" && last.kind !== "error") {
        const r = await withTimeout(iter.next(), 5000, "draining to done after deny");
        if (r.done) break;
        last = r.value;
      }
      expect(last?.kind).toBe("done");
    });

    it("the iterator terminates after 'done'", async () => {
      const session = make().spawn({ cwd: "/tmp", prompt: "hello", permissionMode: "default" });
      const iter = session.events()[Symbol.asyncIterator]();

      let last: AgentEvent | undefined;
      let iteratorDone = false;
      for (let i = 0; i < 100 && !iteratorDone; i++) {
        const r = await withTimeout(iter.next(), 5000, "draining toward done");
        if (r.done) { iteratorDone = true; break; }
        last = r.value;
        if (last.kind === "needs-permission") { session.respondPermission(last.requestId, "allow"); continue; }
        if (last.kind === "done" || last.kind === "error") break;
      }
      expect(iteratorDone).toBe(false);
      expect(last?.kind).toBe("done");

      const after = await withTimeout(iter.next(), 5000, "event after done");
      expect(after.done).toBe(true);
    });

    it("kill() terminates a live iterator", async () => {
      const session = make().spawn({ cwd: "/tmp", prompt: "hello", permissionMode: "default" });
      const iter = session.events()[Symbol.asyncIterator]();

      const first = await withTimeout(iter.next(), 5000, "first event before kill");
      expect(first.done).toBe(false);

      session.kill();

      // kill() closes the queue but any events already buffered before the
      // close still drain first; the iterator must eventually report done.
      let after: IteratorResult<AgentEvent> | undefined;
      for (let i = 0; i < 100; i++) {
        after = await withTimeout(iter.next(), 5000, "event after kill");
        if (after.done) break;
      }
      expect(after?.done).toBe(true);
    });

    it("capabilities() returns all five fields with declared types", () => {
      const caps = make().capabilities();
      expect(typeof caps.images).toBe("boolean");
      expect(["callback", "flags", "none"]).toContain(caps.permissions);
      expect(typeof caps.resume).toBe("boolean");
      expect(typeof caps.queuedInput).toBe("boolean");
      expect(Array.isArray(caps.permissionModes)).toBe(true);
      for (const mode of caps.permissionModes) {
        expect(["default", "acceptEdits", "plan", "bypassPermissions"]).toContain(mode);
      }
    });
  });
}
