import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractCodexFinalMessage,
  initialReport,
  isCompleteReport,
  recoverReport,
} from "./subagent-report.js";

test("isCompleteReport rejects the initial did-not-start placeholder", () => {
  assert.equal(isCompleteReport(initialReport("debater-a"), "debater-a"), false);
});

test("recoverReport returns a valid report from Codex JSON stdout when available", () => {
  const stdout = `${JSON.stringify({
    type: "item.completed",
    item: {
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "status: done\nsummary:\n  - recovered from stdout\n  - review: pass\n",
      }],
    },
  })}\n`;

  assert.equal(extractCodexFinalMessage(stdout), "status: done\nsummary:\n  - recovered from stdout\n  - review: pass");
  assert.equal(recoverReport({
    name: "debater-a",
    exitCode: 0,
    stdout,
    stderr: "",
  }), "status: done\nsummary:\n  - recovered from stdout\n  - review: pass\n");
});

test("recoverReport creates a diagnostic blocked report when stdout has no report", () => {
  const report = recoverReport({
    name: "debater-a",
    exitCode: 0,
    stdout: "",
    stderr: "Reading additional input from stdin...\n",
  });

  assert.equal(isCompleteReport(report, "debater-a"), true);
  assert.match(report, /status: blocked/);
  assert.match(report, /debater-a did not write a valid REPORT file/);
  assert.match(report, /child stderr: Reading additional input from stdin\.\.\./);
});
