#!/usr/bin/env node
// claurp-daemon CLI entry (Task 16 Step 3). Parses --port/--adapter, wires the real production
// DaemonDeps (build-deps.ts), starts the WS server, and shuts down gracefully on SIGINT.
import { buildProductionDaemonDeps } from "./build-deps.js";
import { DaemonServer } from "./server.js";

interface CliArgs {
  port: number;
  adapter: string;
}

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
  const port = await server.start();
  console.log(`claurp-daemon listening on ws://127.0.0.1:${port}`);

  let shuttingDown = false;
  process.on("SIGINT", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      console.log("claurp-daemon: shutting down...");
      await server.stop();
      deps.meter.persist();
      tts.dispose();
      await transcriber.stop();
      process.exit(0);
    })();
  });
}

main().catch((err: unknown) => {
  console.error("claurp-daemon: fatal startup error:", err);
  process.exit(1);
});
