import { describe, expect, it } from "vitest";
import {
  BIN_MIC_PCM16_16K,
  BIN_TTS_PCM16_24K,
  decodeBinaryFrame,
  encodeBinaryFrame,
  parseDaemonMsg,
  parseSensesMsg,
  PROTOCOL_VERSION,
} from "../src/index.js";

describe("protocol messages", () => {
  it("round-trips a senses hello", () => {
    const msg = { v: PROTOCOL_VERSION, type: "hello", client: "senses-macos", protocol: PROTOCOL_VERSION };
    expect(parseSensesMsg(msg)).toEqual(msg);
  });

  it("rejects unknown message types", () => {
    expect(() => parseSensesMsg({ v: 1, type: "nope" })).toThrow();
  });

  it("rejects a mismatched protocol major in hello", () => {
    expect(() => parseSensesMsg({ v: 999, type: "hello", client: "x", protocol: 999 })).toThrow();
  });

  it("parses a daemon permission HUD message", () => {
    const msg = {
      v: PROTOCOL_VERSION,
      type: "hud.permission",
      sessionId: "s1",
      requestId: "r1",
      tool: "Bash",
      detail: "npm install",
      spoken: "Claude wants to run npm install — allow?",
    };
    expect(parseDaemonMsg(msg)).toEqual(msg);
  });

  it("parses a permission response from senses", () => {
    const msg = { v: PROTOCOL_VERSION, type: "permission.response", sessionId: "s1", requestId: "r1", decision: "allow" };
    expect(parseSensesMsg(msg)).toEqual(msg);
  });

  it("round-trips binary PCM frames", () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
    const buf = encodeBinaryFrame(BIN_MIC_PCM16_16K, pcm);
    const out = decodeBinaryFrame(buf);
    expect(out.type).toBe(BIN_MIC_PCM16_16K);
    expect(Array.from(out.pcm)).toEqual(Array.from(pcm));
    expect(BIN_TTS_PCM16_24K).not.toBe(BIN_MIC_PCM16_16K);
  });
});
