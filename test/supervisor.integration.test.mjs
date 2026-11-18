import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { openSwarmDaemon } from "../src/daemon.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

test("integration: real harness auto-continues a turn_limit worker, then notifies lead once", async () => {
  const root = await mkdtemp(join(tmpdir(), "sup-int-"));
  const leadFaux = fauxProvider({ provider: "faux-lead", models: [{ id: "faux-lead-1" }] });
  const workerFaux = fauxProvider({ provider: "faux-worker", models: [{ id: "faux-worker-1" }] });
  const models = createModels();
  models.setProvider(leadFaux.provider);
  models.setProvider(workerFaux.provider);
  const leadRef = { provider: leadFaux.models[0].provider, modelId: leadFaux.models[0].id };
  const workerRef = { provider: workerFaux.models[0].provider, modelId: workerFaux.models[0].id };
  const roleModels = { lead: leadRef, coder: workerRef, reviewer: workerRef, btw: leadRef };

  // lead: spawn worker, then answer + ack bus notifications.
  leadFaux.appendResponses([
    fauxAssistantMessage(fauxToolCall("spawn_worker", { workerId: "w-t", role: "coder", brief: "GOAL-ALPHA build thing" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("spawned w-t"),
    fauxAssistantMessage("ack start"),
    fauxAssistantMessage("ack resume"),
    fauxAssistantMessage("ack done"),
  ]);
  // worker: 40 tool rounds (= maxTurns) -> turn_limit, then auto-resumed finish.
  workerFaux.appendResponses([
    ...Array.from({ length: 40 }, () => fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), { stopReason: "toolUse" })),
    fauxAssistantMessage("resumed and done. Verified: PASS (true)"),
  ]);

  const daemon = await openSwarmDaemon({
    dataDir: join(root, "data"),
    workspaceDir: join(root, "ws"),
    models,
    roleModels,
    supervisor: { maxAutoResumes: 1, backoffMs: 10, intervalMs: 50 },
  });
  daemon.harness.resume();
  try {
    await daemon.chat("spawn one worker", { wait: true });

    const ok = await waitFor(async () => {
      const st = await daemon.status();
      return st.swarm.workers["w-t"]?.supervisor?.status === "done";
    });
    assert.ok(ok, "worker must recover via auto-resume and finish");

    const w = (await daemon.status()).swarm.workers["w-t"];
    assert.equal(w.supervisor.autoResumes, 1);
    assert.equal(w.goal, "GOAL-ALPHA build thing");

    const lead = daemon.bus.inbox("lead");
    const topics = lead.map((m) => m.topic);
    assert.ok(topics.includes("SUPERVISOR_START"));
    assert.ok(topics.includes("SUPERVISOR_RESUME"));
    assert.equal(topics.filter((t) => t === "SUPERVISOR_RESUME").length, 1, "no duplicate resume");
    assert.equal(topics.filter((t) => t === "WORKER_DONE").length, 1, "one terminal notification");
    const resumeMsg = lead.find((m) => m.topic === "SUPERVISOR_RESUME");
    assert.match(resumeMsg.body, /GOAL-ALPHA/);
    assert.match(resumeMsg.body, /turn_limit/);
  } finally {
    await daemon.close();
    leadFaux.unregister?.();
    workerFaux.unregister?.();
    await rm(root, { recursive: true, force: true });
  }
});
