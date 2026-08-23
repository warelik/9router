import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertDemoLockConfig } from "./blabs-demo-preflight.mjs";

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--hostname" ||
    argv[2] !== "--port"
  ) {
    console.error(
      "usage: node scripts/blabs-start.mjs --hostname 127.0.0.1 --port <1-65535>",
    );
    process.exit(2);
  }
  const hostname = argv[1];
  const port = Number(argv[3]);
  if (
    hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    console.error("[blabs-demo-lock] invalid_listen_address");
    process.exit(2);
  }
  return { hostname, port };
}

const { hostname, port } = parseArgs(process.argv.slice(2));
const result = await assertDemoLockConfig();
if (!result.ok) {
  console.error(`[blabs-demo-lock] ${result.error}`);
  process.exit(1);
}

const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(
  process.execPath,
  [
    nextBin,
    "start",
    "--hostname",
    hostname,
    "--port",
    String(port),
  ],
  { cwd: projectRoot, env: process.env, stdio: "inherit" },
);

const handlers = new Map();
let forwardedSignal = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => {
    forwardedSignal = signal;
    child.kill(signal);
  };
  handlers.set(signal, handler);
  process.once(signal, handler);
}

function removeSignalHandlers() {
  for (const [signal, handler] of handlers) {
    process.removeListener(signal, handler);
  }
}

child.once("error", () => {
  removeSignalHandlers();
  console.error("[blabs-demo-lock] next_spawn_failed");
  process.exit(1);
});

child.on("exit", (code, signal) => {
  removeSignalHandlers();
  if (signal || forwardedSignal) {
    process.kill(process.pid, signal || forwardedSignal);
    return;
  }
  process.exit(code ?? 1);
});
