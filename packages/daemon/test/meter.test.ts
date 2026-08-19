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
