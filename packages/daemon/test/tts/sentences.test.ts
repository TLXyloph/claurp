import { describe, expect, it } from "vitest";
import { SentenceSplitter } from "../../src/tts/sentences.js";

describe("SentenceSplitter", () => {
  it("splits completed sentences across pushes and flushes the tail", () => {
    const s = new SentenceSplitter();
    expect(s.push("Hello. Wor")).toEqual(["Hello."]);
    expect(s.push("ld! And")).toEqual(["World!"]);
    expect(s.flush()).toBe("And");
  });

  it("does not protect abbreviations in v0.1 (acceptable for narrator copy, which avoids abbreviations)", () => {
    const s = new SentenceSplitter();
    expect(s.push("e.g. run it. ")).toEqual(["e.g.", "run it."]);
  });

  it("returns null from flush when there is no remaining tail", () => {
    const s = new SentenceSplitter();
    expect(s.flush()).toBeNull();
  });
});
