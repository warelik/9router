import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Vitest runs test files in separate workers against the same CI DATA_DIR.
// Give native route tests their own database before they dynamically import the
// DB-backed routes, then restore the shared environment for any reused worker.
export function isolateDataDir() {
  const original = process.env.DATA_DIR;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "9router-native-db-"));
  process.env.DATA_DIR = directory;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    fs.rmSync(directory, { recursive: true, force: true });
    if (original === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = original;
  };
}
