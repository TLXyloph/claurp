// Regenerates the Swift test fixtures from the real zod schemas.
// Run: pnpm --filter @claurp/protocol golden
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encodeBinaryFrame, parseDaemonMsg, parseSensesMsg } from "../src/index.js";
import { daemonToSenses, sensesToDaemon, frames } from "./golden-samples.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const out = path.join(repoRoot, "apps/senses-macos/Tests/ClaurpSensesCoreTests/Fixtures");

rmSync(out, { recursive: true, force: true });
for (const dir of ["daemon-to-senses", "senses-to-daemon", "frames"]) {
  mkdirSync(path.join(out, dir), { recursive: true });
}

for (const { file, msg } of daemonToSenses) {
  parseDaemonMsg(msg); // throws if a sample ever drifts from the schema
  writeFileSync(path.join(out, "daemon-to-senses", `${file}.json`), JSON.stringify(msg, null, 2) + "\n");
}
for (const { file, msg } of sensesToDaemon) {
  parseSensesMsg(msg);
  writeFileSync(path.join(out, "senses-to-daemon", `${file}.json`), JSON.stringify(msg, null, 2) + "\n");
}
for (const { file, type, pcm } of frames) {
  writeFileSync(path.join(out, "frames", `${file}.bin`), encodeBinaryFrame(type, Int16Array.from(pcm)));
}
console.log(`claurp: wrote golden fixtures to ${out}`);
