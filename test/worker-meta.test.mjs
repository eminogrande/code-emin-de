import assert from "node:assert/strict";
import test from "node:test";
import { describeWorker, lastError, sortWorkers, workerState } from "../src/worker-meta.mjs";

test("worker-meta: state derives only from live run/runFailure", () => {
  assert.equal(workerState({ run: { turns: 3 } }), "running");
  assert.equal(workerState(null), "idle_done");
  assert.equal(workerState({}), "idle_done");
  assert.equal(workerState({ runFailure: { reason: "turn_limit" } }), "failed:turn_limit");
  assert.equal(workerState({ runFailure: { reason: "model_error" } }), "failed");
});

test("worker-meta: lastError is concise, single-line and truncated", () => {
  assert.equal(lastError(null), null);
  assert.equal(lastError({ reason: "turn_limit" }), "turn_limit");
  assert.equal(lastError({ reason: "model_error", detail: "boom\n  x" }), "model_error: boom x");
  const long = lastError({ reason: "model_error", detail: "y".repeat(500) });
  assert.ok(long.length <= 160);
  assert.ok(long.endsWith("…"));
});

test("worker-meta: record exposes only public fields", () => {
  const out = describeWorker(
    { workerId: "w-a", role: "coder", convId: 3, createdAt: 5, modelId: "m1", goal: "SECRET GOAL" },
    { runFailure: { reason: "turn_limit", detail: "max turns" } },
  );
  assert.deepEqual(out, {
    id: "w-a",
    role: "coder",
    conversationId: 3,
    state: "failed:turn_limit",
    createdAt: 5,
    lastError: "turn_limit: max turns",
    model: "m1",
    orchestrationId: "general",
    name: "w-a",
    mode: "once",
    enabled: true,
    everyMs: null,
    runCount: 0,
    lastRunAt: null,
    lastAction: null,
  });
  assert.ok(!("goal" in out));
});

test("worker-meta: sorting puts running first then newest, stable by id", () => {
  const list = [
    { id: "old", state: "idle_done", createdAt: 1 },
    { id: "new", state: "idle_done", createdAt: 9 },
    { id: "run2", state: "running", createdAt: 2 },
    { id: "run1", state: "running", createdAt: 3 },
    { id: "tie", state: "failed", createdAt: 1 },
  ];
  assert.deepEqual(
    sortWorkers(list).map((w) => w.id),
    ["run1", "run2", "new", "old", "tie"],
  );
  assert.deepEqual(sortWorkers(list).map((w) => w.id), sortWorkers(list).map((w) => w.id));
});

test("daemon CoT helpers: extractAssistantThinking, extractAssistantToolCalls, and summarizeLiveProgress", async () => {
  const { extractAssistantThinking, extractAssistantToolCalls, summarizeLiveProgress } = await import("../src/daemon.mjs");
  const entry = {
    model: [
      {
        content: [
          { type: "thinking", thinking: "Step 1: check config" },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls -la" } },
          { type: "text", text: "Done." },
        ],
      },
    ],
  };
  assert.equal(extractAssistantThinking(entry), "Step 1: check config");
  assert.deepEqual(extractAssistantToolCalls(entry), ['bash({"command":"ls -la"})']);

  const live = summarizeLiveProgress({
    run: { taskId: 1, turns: 2 },
    generation: {
      attempt: 1,
      message: {
        content: [
          { type: "thinking", thinking: "Streaming reasoning..." },
          { type: "text", text: "Partial answer" },
        ],
      },
    },
    tools: [{ callId: "tc1", name: "bash", status: "running", output: "stdout line" }],
  });
  assert.deepEqual(live, {
    running: true,
    turns: 2,
    thinking: "Streaming reasoning...",
    text: "Partial answer",
    tools: [{ callId: "tc1", name: "bash", status: "running", output: "stdout line" }],
  });
  assert.equal(summarizeLiveProgress(null), null);
  assert.equal(summarizeLiveProgress({}), null);
});
