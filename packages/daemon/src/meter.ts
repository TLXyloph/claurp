// Passive usage meter (spec §5.5): aggregates only what THIS daemon spawned and observed via
// `usage-metadata` events (Task 16 feeds record()). Rolling day/week summaries and context-fill
// (latest input/window) are computed from that in-memory log alone -- this module never implies
// account-level totals; the narrator (Task 14) owns the "across claurp sessions" phrasing.
//
// Every time read routes through the injected `now` (default `Date.now`) rather than calling
// `Date.now()`/`new Date()` directly elsewhere in this file, so a test-supplied clock fully
// controls rolling-window behavior.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claurpHome } from "./paths.js";

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessions: number;
}

interface UsageRecord {
  ts: number;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_CONTEXT_WINDOW = 200_000;

function usagePath(): string {
  return join(claurpHome(), "usage.jsonl");
}

export class MeterService {
  private readonly now: () => number;
  private readonly records: UsageRecord[] = [];
  // Count of leading `records` entries already flushed to disk. persist() only appends the tail
  // beyond this index, so repeated persist() calls -- and a freshly-loaded instance, which
  // starts with this equal to records.length -- never duplicate rows in the JSONL.
  private persisted = 0;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  record(sessionId: string, u: { inputTokens: number; outputTokens: number; costUsd?: number }): void {
    this.records.push({
      ts: this.now(),
      sessionId,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      costUsd: u.costUsd ?? 0,
    });
  }

  /** Rolling 24h ("day") / 7d ("week") window, measured back from `now()`. `sessions` counts
   *  distinct session ids among the in-window records. */
  summary(period: "day" | "week"): UsageSummary {
    const windowMs = period === "day" ? DAY_MS : WEEK_MS;
    const since = this.now() - windowMs;
    const sessions = new Set<string>();
    const totals: UsageSummary = { inputTokens: 0, outputTokens: 0, costUsd: 0, sessions: 0 };
    for (const r of this.records) {
      if (r.ts < since) continue;
      totals.inputTokens += r.inputTokens;
      totals.outputTokens += r.outputTokens;
      totals.costUsd += r.costUsd;
      sessions.add(r.sessionId);
    }
    totals.sessions = sessions.size;
    return totals;
  }

  /** latest recorded inputTokens for `sessionId`, divided by `windowTokens`; null if the
   *  session has never been recorded. */
  contextFill(sessionId: string, windowTokens = DEFAULT_CONTEXT_WINDOW): number | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.sessionId === sessionId) return r.inputTokens / windowTokens;
    }
    return null;
  }

  /** Appends any not-yet-persisted records to ~/.claurp/usage.jsonl (append-only). */
  persist(): void {
    const pending = this.records.slice(this.persisted);
    if (pending.length === 0) return;
    const path = usagePath();
    mkdirSync(dirname(path), { recursive: true });
    const lines = pending.map((r) => JSON.stringify(r)).join("\n") + "\n";
    appendFileSync(path, lines);
    this.persisted = this.records.length;
  }

  /** Replays ~/.claurp/usage.jsonl into a fresh MeterService. Tolerant of a missing file. */
  static load(opts?: { now?: () => number }): MeterService {
    const meter = new MeterService(opts);
    const path = usagePath();
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        meter.records.push(JSON.parse(trimmed) as UsageRecord);
      }
    }
    meter.persisted = meter.records.length;
    return meter;
  }
}
