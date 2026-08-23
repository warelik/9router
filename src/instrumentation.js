import { enforceDemoLockStartupOrExit } from "@/lib/blabs/demoPolicy";

export async function register() {
  await enforceDemoLockStartupOrExit();
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();
  }
}
