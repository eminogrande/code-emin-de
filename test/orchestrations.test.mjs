import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openSwarmDaemon } from "../src/daemon.mjs";
import { createBuiltinGuardHooks, HookRegistry } from "../src/hooks.mjs";
import {
  AGENT_PRESETS,
  MIN_WORKER_INTERVAL_MS,
  nextRunAt,
  publicOrchestration,
  resolveSafeAgentCwd,
  validateOrchestrationInput,
  validateOrchestrationName,
  validateWorkerInput,
} from "../src/orchestrations.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

function fakeRuntime(root) {
  const faux = fauxProvider({ provider: "faux-orchestration", models: [{ id: "faux-1" }] });
  faux.appendResponses(Array.from({ length: 20 }, (_, i) => fauxAssistantMessage(`run ${i + 1} done. Verified: PASS (fake)`)));
  const models = createModels();
  models.setProvider(faux.provider);
  const ref = { provider: "faux-orchestration", modelId: "faux-1" };
  const roleModels = Object.fromEntries(["lead", "planner", "coder", "coderFast", "reviewer", "reviewerDeep", "support", "social", "watcher", "btw"].map((k) => [k, ref]));
  return { models, roleModels, faux, dataDir: join(root, "data"), workspaceDir: join(root, "workspace") };
}

test("validation bounds orchestration names, goals, roles and schedules", () => {
  assert.equal(validateOrchestrationName("  Research  "), "Research");
  assert.throws(() => validateOrchestrationName(" "), /required/);
  assert.throws(() => validateOrchestrationName("x".repeat(61)), /60/);
  assert.deepEqual(validateWorkerInput({ name: "Build", goal: "Ship it", role: "coder", mode: "once" }), {
    name: "Build", role: "coder", goal: "Ship it", mode: "once", everyMs: null,
  });
  const recurring = validateWorkerInput({ name: "Watch", goal: "Check", role: "watcher", mode: "recurring", everyMs: 10000 });
  assert.equal(recurring.everyMs, MIN_WORKER_INTERVAL_MS);
  assert.throws(() => validateWorkerInput({ name: "x", goal: "x", mode: "recurring", everyMs: 9999 }), /everyMs/);
  assert.throws(() => validateWorkerInput({ name: "x", goal: "x", role: "root" }), /role/);
  assert.throws(() => validateWorkerInput({ name: "x", goal: "x", mode: "sometimes" }), /mode/);
  assert.equal(publicOrchestration({ id: "a", name: "A", convId: 2 }, { run: {} }).state, "running");
  assert.equal(nextRunAt({ mode: "recurring", enabled: true, everyMs: 10000, lastRunAt: 100 }, 200), 10100);
  assert.equal(nextRunAt({ mode: "recurring", enabled: false, everyMs: 10000 }, 200), null);
});

test("named Lead + one-shot/recurring workers persist across real daemon restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrations-restart-"));
  const rt = fakeRuntime(root);
  let daemon = await openSwarmDaemon(rt);
  try {
    assert.deepEqual((await daemon.listOrchestrations()).map((o) => o.id), ["general"]);
    const orch = await daemon.createOrchestration("Infrastructure");
    assert.ok(orch.conversationId > 1);
    const once = await daemon.createOrchestrationWorker(orch.id, {
      name: "Release", role: "coder", goal: "Prepare release", mode: "once",
    });
    const recurring = await daemon.createOrchestrationWorker(orch.id, {
      name: "Health", role: "watcher", goal: "Check health", mode: "recurring", everyMs: 10000,
    });
    assert.ok(recurring.taskId, "recurring worker owns a durable task");
    await daemon.setOrchestrationWorkerEnabled(recurring.id, false);
    await assert.rejects(() => daemon.triggerOrchestrationWorker(recurring.id), /paused/);
    const beforeRestartRunCount = (await daemon.listWorkers()).find((w) => w.id === recurring.id).runCount;
    await daemon.close();

    daemon = await openSwarmDaemon(rt);
    const sessions = await daemon.listOrchestrations();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[1].name, "Infrastructure");
    assert.equal(sessions[1].conversationId, orch.conversationId);
    const workers = (await daemon.listWorkers()).filter((w) => w.orchestrationId === orch.id);
    assert.equal(workers.length, 2);
    assert.equal(workers.find((w) => w.id === once.id).mode, "once");
    const persisted = workers.find((w) => w.id === recurring.id);
    assert.equal(persisted.mode, "recurring");
    assert.equal(persisted.enabled, false);
    assert.equal(persisted.everyMs, 10000);
    assert.equal(persisted.nextRunAt, null);
    assert.ok(persisted.runCount >= beforeRestartRunCount, "durable run counter survives restart without resetting");
    assert.ok(!JSON.stringify(persisted).includes("Check health"), "public list does not expose private goals");
  } finally {
    await daemon.close();
    rt.faux.unregister?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable scheduler executes recurring work and pause prevents submissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrations-schedule-"));
  const rt = fakeRuntime(root);
  const daemon = await openSwarmDaemon(rt);
  try {
    const orch = await daemon.createOrchestration("Monitor");
    const worker = await daemon.createOrchestrationWorker(orch.id, {
      name: "Pulse", role: "watcher", goal: "Report one pulse", mode: "recurring", everyMs: 10000,
    });
    daemon.harness.resume();
    assert.ok(await waitFor(async () => (await daemon.listWorkers()).find((w) => w.id === worker.id)?.runCount === 1), "initial durable tick runs");
    await daemon.setOrchestrationWorkerEnabled(worker.id, false);
    const before = (await daemon.listWorkers()).find((w) => w.id === worker.id).runCount;
    await sleep(150);
    assert.equal((await daemon.listWorkers()).find((w) => w.id === worker.id).runCount, before);
    assert.equal((await daemon.readTranscript(worker.conversationId, 10)).filter((e) => e.role === "user").length, 1);
    await assert.rejects(() => daemon.createOrchestrationWorker("missing", { name: "x", goal: "x" }), /Unknown orchestration/);
  } finally {
    await daemon.close();
    rt.faux.unregister?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("typed agent-orchestrators: presets, safe cwd, update persistence, and preset guard hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrations-presets-"));
  const ws = join(root, "workspace");
  assert.ok(AGENT_PRESETS.repo && AGENT_PRESETS.marketing && AGENT_PRESETS.security);
  assert.equal(resolveSafeAgentCwd("nuri-website", ws), join(ws, "nuri-website"));
  assert.throws(() => resolveSafeAgentCwd("../../etc", ws), /inside/);
  assert.throws(() => validateOrchestrationInput({ name: "Bad", preset: "nope" }, ws), /Unknown preset/);
  assert.throws(() => validateOrchestrationInput({ name: "Bad", repoUrl: "javascript:alert(1)" }, ws), /repoUrl/);

  // Preset guard hooks: security=readonly, marketing=draft-only, repo=git push ok (never force / never swarm-ctl)
  const reg = new HookRegistry(createBuiltinGuardHooks());
  assert.ok((await reg.runBeforeTool({ name: "edit", arguments: {} }, { meta: { role: "orchestrator", preset: "security" } }))?.block);
  assert.ok((await reg.runBeforeTool({ name: "bash", arguments: { command: "curl https://api.linkedin.com/v2/ugcPosts" } }, { meta: { role: "orchestrator", preset: "marketing" } }))?.block);
  assert.ok((await reg.runBeforeTool({ name: "bash", arguments: { command: "curl https://open.tiktokapis.com/v2/post/publish" } }, { meta: { role: "orchestrator", preset: "marketing" } }))?.block);
  assert.equal(await reg.runBeforeTool({ name: "bash", arguments: { command: "git push origin preview" } }, { meta: { role: "orchestrator", preset: "repo" } }), undefined);
  assert.ok((await reg.runBeforeTool({ name: "bash", arguments: { command: "git push --force origin main" } }, { meta: { role: "orchestrator", preset: "repo" } }))?.block);
  assert.ok((await reg.runBeforeTool({ name: "bash", arguments: { command: "sudo /usr/local/bin/swarm-ctl apply" } }, { meta: { role: "orchestrator", preset: "repo" } }))?.block);
  assert.ok((await reg.runBeforeTool({ name: "bash", arguments: { command: "git push origin main" } }, { meta: { role: "coder" } }))?.block);

  const rt = fakeRuntime(root);
  let daemon = await openSwarmDaemon(rt);
  try {
    const repo = await daemon.createOrchestration({
      name: "nuri-website",
      preset: "repo",
      cwd: "nuri-website",
      repoUrl: "https://github.com/nuri-com/nuri-website",
      instructions: "Push preview for staging GH Actions.",
    });
    assert.equal(repo.preset, "repo");
    assert.equal(repo.group, "Repos");
    assert.equal(repo.cwd, join(ws, "nuri-website"));

    const mkt = await daemon.createOrchestration({ name: "linkedin-marketer", preset: "marketing" });
    assert.equal(mkt.group, "Marketing");

    await daemon.updateOrchestration(mkt.id, { group: "Growth", instructions: "Weekly LinkedIn drafts only." });
    await daemon.close();

    daemon = await openSwarmDaemon(rt);
    const list = await daemon.listOrchestrations();
    const persistedRepo = list.find((o) => o.id === repo.id);
    const persistedMkt = list.find((o) => o.id === mkt.id);
    assert.equal(persistedRepo.cwd, join(ws, "nuri-website"));
    assert.equal(persistedRepo.repoUrl, "https://github.com/nuri-com/nuri-website");
    assert.equal(persistedMkt.group, "Growth");
    assert.equal(persistedMkt.instructions, "Weekly LinkedIn drafts only.");
  } finally {
    await daemon.close();
    rt.faux.unregister?.();
    await rm(root, { recursive: true, force: true });
  }
});
