import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openSwarmDaemon } from "../src/daemon.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await sleep(25);
  }
  throw new Error("timed out");
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function runtime(root, respond) {
  const faux = fauxProvider({ provider: "faux-parallel-inbox", models: [{ id: "faux-1" }] });
  faux.setResponses(Array.from({ length: 20 }, () => respond));
  const models = createModels();
  models.setProvider(faux.provider);
  const ref = { provider: "faux-parallel-inbox", modelId: "faux-1" };
  const roleModels = Object.fromEntries(["lead", "planner", "coder", "coderFast", "reviewer", "reviewerDeep", "support", "social", "watcher", "btw"].map((k) => [k, ref]));
  return { models, roleModels, faux, dataDir: join(root, "data"), workspaceDir: join(root, "workspace"), supervisor: { intervalMs: 100_000 } };
}

function promptOf(context) {
  const message = [...context.messages].reverse().find((m) => m.role === "user");
  if (typeof message?.content === "string") return message.content;
  return message?.content?.filter((b) => b.type === "text").map((b) => b.text).join("\n") || "";
}

test("busy Lead prompts run concurrently and results route to the requester once", async () => {
  const root = await mkdtemp(join(tmpdir(), "parallel-inbox-"));
  const first = deferred();
  const second = deferred();
  let daemon;
  const rt = runtime(root, (context) => {
    const prompt = promptOf(context);
    if (prompt === "first") return first.promise;
    if (prompt.includes("second")) return second.promise;
    throw new Error(`unexpected prompt: ${prompt}`);
  });
  try {
    daemon = await openSwarmDaemon(rt);
    const initial = await daemon.chat("first", { wait: false });
    const started = await daemon.chat("second", { wait: false, requestId: "req-second" });
    assert.equal(started.route, "parallel_inbox");
    assert.notEqual(started.workerConversationId, initial.conversationId);
    assert.ok(await waitFor(async () => (await daemon.readTranscript(started.workerConversationId, 5)).some((e) => e.role === "user" && e.text.includes("second"))));
    assert.equal((await daemon.status()).lead.busy, true, "second begins while first is still running");

    const duplicate = await daemon.chat("second", { wait: false, requestId: "req-second" });
    assert.equal(duplicate.workerId, started.workerId);
    assert.equal((await daemon.listWorkers()).filter((w) => w.id === started.workerId).length, 1);

    second.resolve(fauxAssistantMessage("SECOND-RESULT"));
    const routed = await waitFor(async () => (await daemon.readTranscript(1, 20)).find((e) => e.kind === "swarm.parallel_result" && e.text === "SECOND-RESULT"));
    assert.equal(routed.workerId, started.workerId);
    assert.equal((await daemon.readTranscript(1, 20)).filter((e) => e.role === "user" && e.text === "second").length, 1);
    first.resolve(fauxAssistantMessage("FIRST-RESULT"));
    assert.equal(typeof (await daemon.harness.submission(initial.submissionId)).wait, "function"); // original remains independently awaitable
  } finally {
    first.resolve(fauxAssistantMessage("FIRST-RESULT"));
    second.resolve(fauxAssistantMessage("SECOND-RESULT"));
    await daemon?.close();
    rt.faux.unregister?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery task recovers an unstarted worker and survives daemon restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "parallel-inbox-restart-"));
  const leadGate = deferred();
  const rt = runtime(root, (context) => {
    const prompt = promptOf(context);
    if (prompt === "block lead") return leadGate.promise;
    if (prompt.includes("restart me")) return fauxAssistantMessage("RECOVERED-RESULT");
    throw new Error(`unexpected prompt: ${prompt}`);
  });
  let daemon;
  try {
    daemon = await openSwarmDaemon(rt);
    await daemon.chat("block lead", { wait: false });
    const accepted = await daemon.chat("restart me", { wait: false, requestId: "req-restart" });
    const workerConv = await daemon.harness.conversation(accepted.workerConversationId, (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT);
    leadGate.resolve(fauxAssistantMessage("LEAD-DONE"));
    await sleep(50);
    await daemon.close();

    daemon = await openSwarmDaemon(rt);
    daemon.harness.resume();
    const result = await waitFor(async () => (await daemon.readTranscript(1, 20)).find((e) => e.kind === "swarm.parallel_result" && e.text === "RECOVERED-RESULT"));
    assert.equal(result.workerId, accepted.workerId);
    assert.equal((await daemon.readTranscript(accepted.workerConversationId, 20)).filter((e) => e.role === "user" && e.text.includes("restart me")).length, 1);
  } finally {
    leadGate.resolve(fauxAssistantMessage("LEAD-DONE"));
    await daemon?.close();
    rt.faux.unregister?.();
    await rm(root, { recursive: true, force: true });
  }
});
