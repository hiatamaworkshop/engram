// ============================================================
// Receptor — runtime data directory
// ============================================================
// The one place every receptor module resolves its output directory.
// The MCP server runs from dist/receptor, so its data lands in
// dist/receptor-output. CLIs run with tsx from src/receptor would otherwise
// resolve src/receptor-output and read a different, stale directory.
// tsc never deletes this directory, so a rebuild keeps the data.

import * as path from "node:path";

function resolve(): string {
  if (process.env.ENGRAM_DATA_DIR) return path.join(process.env.ENGRAM_DATA_DIR, "receptor-output");
  const here = import.meta.dirname ?? ".";
  const pkgRoot = path.join(here, "..", "..");
  const fromSrc = path.basename(path.dirname(here)) === "src";
  return fromSrc
    ? path.join(pkgRoot, "dist", "receptor-output")
    : path.join(here, "..", "receptor-output");
}

export const RECEPTOR_OUTPUT_DIR = resolve();
