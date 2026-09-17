// ============================================================
// Hook payload → NormalizedEvent — Unit Tests
// ============================================================
// Payloads are the shapes captured from Claude Code on 2026-09-17
// (docs/RECEPTOR_PRECISION_GAPS.md §1).
// Run: npx tsx --test src/receptor/hook-payload.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHookPayload } from "./hook-payload.js";
import { normalize } from "./normalizer.js";
import { computeImpulse } from "./emotion.js";
import type { WindowSnapshot } from "./commander.js";

function resultOf(payload: Record<string, unknown>) {
  const raw = parseHookPayload(payload);
  if (!raw) return null;
  return normalize(raw);
}

const ok = (tool_name: string, tool_input: object, tool_response: object) =>
  ({ hook_event_name: "PostToolUse", tool_name, tool_input, tool_response });

const fail = (tool_name: string, tool_input: object, error: string, is_interrupt = false) =>
  ({ hook_event_name: "PostToolUseFailure", tool_name, tool_input, error, is_interrupt });

describe("PostToolUse (success path)", () => {
  it("Bash success", () => {
    const e = resultOf(ok("Bash", { command: "ls" },
      { stdout: "a", stderr: "", interrupted: false, isImage: false, noOutputExpected: false }));
    assert.equal(e?.action, "shell_exec");
    assert.equal(e?.result, "success");
  });

  it("grep no match is empty, not failure", () => {
    const e = resultOf(ok("Bash", { command: "grep -q x f" },
      { stdout: "", stderr: "", interrupted: false, isImage: false, returnCodeInterpretation: "No matches found" }));
    assert.equal(e?.result, "empty");
  });

  it("output with empty stdout is not guessed into failure", () => {
    const e = resultOf(ok("Bash", { command: "git push" },
      { stdout: "", stderr: "To github.com:x/y.git", interrupted: false, isImage: false }));
    assert.equal(e?.result, "success");
  });

  it("Bash interrupted", () => {
    const e = resultOf(ok("Bash", { command: "sleep 99" },
      { stdout: "", stderr: "", interrupted: true, isImage: false }));
    assert.equal(e?.result, "interrupted");
  });

  it("PowerShell maps to shell_exec", () => {
    const e = resultOf(ok("PowerShell", { command: "Write-Output ok" },
      { stdout: "ok", stderr: "", interrupted: false, isImage: false }));
    assert.equal(e?.action, "shell_exec");
    assert.equal(e?.result, "success");
  });

  it("NotebookEdit maps to file_edit", () => {
    const e = resultOf(ok("NotebookEdit", { notebook_path: "a.ipynb" }, {}));
    assert.equal(e?.action, "file_edit");
  });
});

describe("PostToolUseFailure", () => {
  it("Bash non-zero exit is failure", () => {
    const e = resultOf(fail("Bash", { command: "ls /x; exit 3" },
      "Exit code 3\nls: cannot access '/x': No such file or directory"));
    assert.equal(e?.action, "shell_exec");
    assert.equal(e?.result, "failure");
  });

  it("PowerShell non-zero exit is failure", () => {
    const e = resultOf(fail("PowerShell", { command: "cmd /c exit 5" }, "Exit code 5"));
    assert.equal(e?.result, "failure");
  });

  it("shell failure without an exit code is dropped, not guessed", () => {
    assert.equal(resultOf(fail("Bash", { command: "x" }, "Command timed out")), null);
  });

  it("interrupt stays its own channel", () => {
    const e = resultOf(fail("Bash", { command: "sleep 99" }, "Interrupted", true));
    assert.equal(e?.result, "interrupted");
  });

  it("Read of a missing file is a file_read failure", () => {
    const e = resultOf(fail("Read", { file_path: "C:\\x\\no-such-file.txt" },
      "File does not exist. Note: your current working directory is C:\\x."));
    assert.equal(e?.action, "file_read");
    assert.equal(e?.result, "failure");
  });

  it("unmapped tools are still skipped", () => {
    assert.equal(resultOf(fail("TodoWrite", { todos: [] }, "invalid")), null);
  });

  it("WebFetch failure is a search failure without a path", () => {
    const e = resultOf(fail("WebFetch", { url: "https://x" }, "404"));
    assert.equal(e?.action, "search");
    assert.equal(e?.result, "failure");
    assert.equal(e?.path, undefined);
  });
});

describe("failure impulses", () => {
  const snap = { pattern: "stagnation" } as unknown as WindowSnapshot;
  const meta = { totalEvents: 1, elapsedMs: 0 };

  it("failed edit gets no work credit", () => {
    const e = resultOf(fail("Write", { file_path: "a.ts" }, "denied"))!;
    const v = computeImpulse(snap, meta, e);
    assert.ok(v.frustration > 0);
    assert.ok(v.confidence < 0);
    assert.equal(v.flow, 0);
  });

  it("failed read lowers seeking", () => {
    const e = resultOf(fail("Read", { file_path: "no-such" }, "File does not exist."))!;
    assert.ok(computeImpulse(snap, meta, e).seeking < 0);
  });
});
