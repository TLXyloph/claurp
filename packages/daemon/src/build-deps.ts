// Shared production wiring for DaemonDeps -- real audio pipeline (Tasks 3-7), real Kokoro TTS
// (T15), both adapters registered (T9/T12), loaded projects (T10), and a guarded MeterService
// load (see loadMeterGuarded()). Used by cli.ts, tools/demo.ts, and test/e2e.test.ts so all
// three exercise the exact same production wiring rather than three near-duplicate copies.
import type { AgentAdapter } from "@claurp/protocol";
import { ClaudeAdapter } from "./agents/claude.js";
import { FakeAgent } from "./agents/fake.js";
import { AudioPipeline } from "./audio/pipeline.js";
import type { PipelineEvent } from "./audio/pipeline.js";
import { createSileroVad } from "./audio/vad.js";
import { createSmartTurn } from "./audio/turn.js";
import { createWakeSpotter } from "./audio/wake.js";
import { createWhisperTranscriber, type Transcriber } from "./audio/transcriber.js";
import { MeterService } from "./meter.js";
import { Narrator } from "./narrator.js";
import { PermissionPolicy } from "./policy.js";
import type { DaemonDeps, PipelineLike } from "./server.js";
import { loadProjects } from "./sessions/projects.js";
import { createKokoroTts, type KokoroTtsHandle } from "./tts/kokoro.js";

// Warn at most once per process, matching the existing warn-once conventions in this package
// (e.g. policy.ts's corrupt-policy-file warning).
let warnedCorruptMeter = false;

/** T13 carry-forward: MeterService.load() can throw on a corrupt usage.jsonl line. A corrupt
 *  file must not crash startup -- fall back to a fresh meter and warn once. */
function loadMeterGuarded(): MeterService {
  try {
    return MeterService.load();
  } catch (err) {
    if (!warnedCorruptMeter) {
      warnedCorruptMeter = true;
      console.warn(`claurp: usage.jsonl unreadable, starting with a fresh meter: ${(err as Error).message}`);
    }
    return new MeterService();
  }
}

export interface ProductionDaemonDeps {
  deps: DaemonDeps;
  transcriber: Transcriber; // held so callers can stop() it (kills the whisper-server child) on shutdown
  tts: KokoroTtsHandle; // held so callers can dispose() it on shutdown
}

export async function buildProductionDaemonDeps(opts: { defaultAdapter: string }): Promise<ProductionDaemonDeps> {
  const transcriber = createWhisperTranscriber();
  await transcriber.start();

  const pipelineFactory = async (onEvent: (e: PipelineEvent) => void): Promise<PipelineLike> => {
    const [vad, wake, turn] = await Promise.all([createSileroVad(), createWakeSpotter(), createSmartTurn()]);
    return new AudioPipeline({ vad, wake, transcriber, turn }, onEvent);
  };

  const tts = await createKokoroTts();

  const adapters = new Map<string, AgentAdapter>([
    ["fake", new FakeAgent()],
    ["claude", new ClaudeAdapter()],
  ]);

  const deps: DaemonDeps = {
    pipelineFactory,
    adapters,
    defaultAdapter: opts.defaultAdapter,
    projects: loadProjects(),
    policy: new PermissionPolicy(),
    meter: loadMeterGuarded(),
    narrator: new Narrator(),
    tts,
  };

  return { deps, transcriber, tts };
}
