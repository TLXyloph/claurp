#!/usr/bin/env node
// claurp-daemon CLI entry (Task 16 Step 3). Parses --port/--adapter, wires the real production
// DaemonDeps (build-deps.ts), starts the WS server, and shuts down gracefully on SIGINT.
import { buildProductionDaemonDeps } from "./build-deps.js";
import { DaemonServer } from "./server.js";

interface CliArgs {
  port: number;
  adapter: string;
}

// Review fix (Important): last-resort backstop. DaemonServer's own session pump (server.ts)
// now catches iterator rejections itself, but this covers anything else in the process that
// might still reject unhandled -- one bad promise anywhere should never take the whole daemon
// down. Deliberately does NOT exit; just logs, so the daemon stays up for every other session.
process.on("unhandledRejection", (reason) => {
  console.error("claurp-daemon: unhandled rejection (daemon staying up):", reason);
});

function parseArgs(argv: string[]): CliArgs {
  let port = 8765;
  let adapter = "claude";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1] !== undefined) {
      port = Number(argv[++i]);
    } else if (argv[i] === "--adapter" && argv[i + 1] !== undefined) {
      adapter = argv[++i];
    }
  }
  return { port, adapter };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { deps, transcriber, tts } = await buildProductionDaemonDeps({ defaultAdapter: args.adapter });

  const server = new DaemonServer(deps, { port: args.port });
  let port: number;
  try {
    port = await server.start();
  } catch (err) {
    // Review fix (Important): the whisper/kokoro children buildProductionDaemonDeps() spawned
    // above are already running by this point -- if start() throws (e.g. port already in
    // use), tear them down before exiting so neither is left orphaned (whisper-server holding
    // its port, or a resident kokoro worker process).
    console.error("claurp-daemon: fatal startup error:", err);
    tts.dispose();
    await transcriber.stop();
    process.exit(1);
  }
  console.log(`claurp-daemon listening on ws://127.0.0.1:${port}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      console.log(`claurp-daemon: shutting down (${signal})...`);
      await server.stop();
      deps.meter.persist();
      tts.dispose();
      await transcriber.stop();
      process.exit(0);
    })();
  };
  // Review fix (Important): SIGTERM (the default signal `kill`/process managers/systemd send)
  // gets the exact same graceful shutdown as SIGINT (Ctrl-C) -- previously only SIGINT was
  // handled, so anything sending SIGTERM would hard-kill the process, orphaning the
  // whisper-server and kokoro worker children.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("claurp-daemon: fatal startup error:", err);
  process.exit(1);
});
