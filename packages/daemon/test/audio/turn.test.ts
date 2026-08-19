import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { int16ToFloat32, readWavPcm16Mono } from "../../src/audio/pcm.js";
import { modelPath } from "../../src/paths.js";
import { createSmartTurn } from "../../src/audio/turn.js";

const FIX = join(import.meta.dirname, "..", "fixtures");
const haveModel = existsSync(modelPath("smart-turn-v3.onnx"));

describe.skipIf(!haveModel)("smart-turn v3", () => {
  it("marks a finished sentence complete and a mid-word cut incomplete", async () => {
    const turn = await createSmartTurn();
    const full = int16ToFloat32(readWavPcm16Mono(join(FIX, "hey_claude_create_file.wav")).pcm);
    // cut at 55% of the speech — mid-utterance, no trailing silence
    const cut = full.slice(0, Math.floor(full.length * 0.55));
    expect(await turn.isComplete(full)).toBe(true);
    expect(await turn.isComplete(cut)).toBe(false);
  });
});
