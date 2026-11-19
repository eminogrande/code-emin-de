import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeStandardizedKimiCost,
  parseKimiCodeTelemetry,
  parseOpenCodeTelemetry,
  parsePiCliTelemetry,
  renderHarnessBenchmarkMarkdown,
  EPISODE_2_SUPERVISOR_AND_CLIENT_BUGFIX,
  EPISODE_4_AGENTS_SIDEBAR_REPAIR,
} from "../src/harness-bench.mjs";

test("1. computeStandardizedKimiCost applies exact K3.1 Pro pricing across uncached, cached, and output tokens", () => {
  const cost = computeStandardizedKimiCost({
    inputTokens: 100_000, // $0.20
    cacheReadTokens: 500_000, // $0.10
    outputTokens: 10_000, // $0.10
  });
  assert.equal(cost, 0.4);
});

test("2. parsePiCliTelemetry + parseOpenCodeTelemetry + parseKimiCodeTelemetry extract tokens, toolCalls, and finalReply", async () => {
  const piOut = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash" }],
        usage: { input: 1000, cacheRead: 4000, output: 200, reasoning: 80 },
      },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Fixed all tests." }],
        usage: { input: 500, cacheRead: 4500, output: 100, reasoning: 20 },
      },
    }),
  ].join("\n");
  const piTel = parsePiCliTelemetry(piOut);
  assert.equal(piTel.toolCalls, 1);
  assert.equal(piTel.inputTokens, 1500);
  assert.equal(piTel.cacheReadTokens, 8500);
  assert.equal(piTel.outputTokens, 300);
  assert.equal(piTel.reasoningTokens, 100);
  assert.equal(piTel.finalReply, "Fixed all tests.");

  const ocOut = [
    JSON.stringify({ type: "tool_use", part: { tool: "edit" } }),
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 2000, output: 150, reasoning: 50, cache: { read: 6000 } } } }),
    JSON.stringify({ type: "text", part: { text: "All green." } }),
  ].join("\n");
  const ocTel = parseOpenCodeTelemetry(ocOut);
  assert.equal(ocTel.toolCalls, 1);
  assert.equal(ocTel.totalTokens, 8150);
  assert.equal(ocTel.finalReply, "All green.");

  const tmp = await mkdtemp(join(tmpdir(), "kimi-tel-"));
  try {
    const sessDir = join(tmp, "sess1");
    await import("node:fs/promises").then((fs) => fs.mkdir(join(sessDir, "agents", "main"), { recursive: true }));
    await writeFile(
      join(sessDir, "agents", "main", "wire.jsonl"),
      [
        JSON.stringify({ type: "usage.record", usageScope: "turn", usage: { inputOther: 1200, inputCacheRead: 10000, output: 250 } }),
        JSON.stringify({ type: "agent.message.appended", message: { message: { content: [{ type: "think", think: "abcd".repeat(25) }] } } }),
      ].join("\n"),
    );
    const idxPath = join(tmp, "session_index.jsonl");
    await writeFile(idxPath, JSON.stringify({ sessionId: "s_1", sessionDir: sessDir }) + "\n");
    const kimiStdout = [
      JSON.stringify({ role: "assistant", tool_calls: [{ id: "t1" }, { id: "t2" }] }),
      JSON.stringify({ role: "assistant", content: "Kimi done." }),
      JSON.stringify({ type: "session.resume_hint", session_id: "s_1" }),
    ].join("\n");
    const kTel = await parseKimiCodeTelemetry(kimiStdout, { sessionIndexPath: idxPath });
    assert.equal(kTel.toolCalls, 2);
    assert.equal(kTel.inputTokens, 1200);
    assert.equal(kTel.cacheReadTokens, 10000);
    assert.equal(kTel.outputTokens, 250);
    assert.equal(kTel.reasoningTokens, 25);
    assert.equal(kTel.finalReply, "Kimi done.");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("3. renderHarnessBenchmarkMarkdown formats ranked cross-harness table cleanly", () => {
  const md = renderHarnessBenchmarkMarkdown({
    episode: EPISODE_2_SUPERVISOR_AND_CLIENT_BUGFIX,
    runs: [
      {
        candidateId: "harness-kimi-code-k31",
        compositeRank: 1180,
        config: { harness: "kimi-code", label: "Kimi Code CLI", coderModel: "kimi-code/k3.1-pro" },
        metrics: { testPass: true, toolCalls: 8, totalTokens: 45000, inputTokens: 5000, cacheReadTokens: 39000, outputTokens: 1000, codeLoc: 32, costUsd: 0.0278, wallClockSec: 42.1 },
        judge: { blindLabel: "Candidate-A", meanScore: 91, votes: [{ persona: "correctness", valid: true, score: 91, rationale: "Minimal root-cause fix." }] },
      },
    ],
  });
  assert.match(md, /Kimi Code CLI/);
  assert.match(md, /91/);
  assert.match(md, /Minimal root-cause fix/);
  assert.equal(EPISODE_4_AGENTS_SIDEBAR_REPAIR.baseCommit, "eb803b4");
});
