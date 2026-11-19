import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  DETERMINISTIC_COMMAND_NAMES,
  handleDeterministicCommand,
  parseSlashCommand,
  probeProviderHealth,
} from "../src/commands.mjs";
import { openSwarmDaemon } from "../src/daemon.mjs";

test("1. parseSlashCommand parses deterministic commands and ignores normal text", () => {
  assert.equal(parseSlashCommand("hello world"), null);
  assert.equal(parseSlashCommand(""), null);
  assert.deepEqual(parseSlashCommand("/status"), { name: "/status", args: "", raw: "/status" });
  assert.deepEqual(parseSlashCommand("  /HOOKS  verbose "), {
    name: "/hooks",
    args: "verbose",
    raw: "/HOOKS  verbose",
  });
  assert.ok(DETERMINISTIC_COMMAND_NAMES.includes("/credits"));
});

test("2. probeProviderHealth reports configured/unconfigured, HTTP 402 billing exhaustion, and offline local server without throwing", async () => {
  const fakeFetch = async (url) => {
    if (String(url).includes("llmgateway")) {
      return new Response('{"error":"Insufficient credits"}', { status: 402 });
    }
    if (String(url).includes("allmodels")) {
      return new Response('{"data":[]}', { status: 200 });
    }
    throw new Error("connect ECONNREFUSED 127.0.0.1:8089");
  };

  const results = await probeProviderHealth({
    env: {
      LLMGATEWAY_API_KEY: "test-key",
      ALLMODELS_API_KEY: "test-key",
      LOCAL_LLAMA_URL: "http://127.0.0.1:8089/v1",
      LOCAL_LLAMA_MODEL: "LFM3-1.7B-Q4_K_M",
    },
    fetchImpl: fakeFetch,
    timeoutMs: 500,
  });

  assert.equal(results.length, 3);
  assert.equal(results[0].name, "llmgateway");
  assert.equal(results[0].ok, false);
  assert.equal(results[0].status, "HTTP 402");
  assert.match(results[0].detail, /credits exhausted/i);

  assert.equal(results[1].name, "allmodels");
  assert.equal(results[1].ok, true);
  assert.equal(results[1].status, "HTTP 200");

  assert.match(results[2].name, /local-llama/);
  assert.equal(results[2].ok, false);
  assert.equal(results[2].status, "unreachable");
  assert.match(results[2].detail, /ECONNREFUSED/);
});

test("3. handleDeterministicCommand formats describeWorker shape (id, role, state, model, lastError) and returns null for /btw", async () => {
  const resBtw = await handleDeterministicCommand("/btw what is running?");
  assert.equal(resBtw, null);
  const resChat = await handleDeterministicCommand("fix the bug in src/web.mjs");
  assert.equal(resChat, null);

  const resWorkers = await handleDeterministicCommand("/workers", {
    listWorkers: async () => [
      {
        id: "w-auth",
        role: "coder",
        state: "running",
        model: "deepseek-v4.1-flash-uncensored",
        lastError: null,
      },
      {
        id: "w-old",
        role: "reviewer",
        state: "failed:turn_limit",
        model: "kimi-k3.1-pro",
        lastError: "turn_limit: 8 turns",
      },
    ],
  });
  assert.equal(resWorkers.llmCalls, 0);
  assert.match(resWorkers.text, /`w-auth` \[coder\] — \*\*RUNNING\*\* · `deepseek-v4\.1-flash-uncensored`/);
  assert.match(resWorkers.text, /`w-old` \[reviewer\] — \*\*FAILED:TURN_LIMIT\*\* · `kimi-k3\.1-pro` · err: turn_limit: 8 turns/);
  assert.doesNotMatch(resWorkers.text, /undefined/);
});

test("4. Daemon E2E: /help, /status, /workers, /hooks, /credits execute with ZERO LLM calls even when all models throw", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "swarm-cmd-test-"));
  let modelCallCount = 0;

  // Deliberately broken provider: ANY LLM call throws immediately (simulating total cloud + local outage!)
  const brokenModels = createModels([
    fauxProvider({
      name: "offline-sim",
      models: [{ id: "dead-model", name: "Dead Model", contextWindow: 128000, maxTokens: 4096 }],
    }),
  ]);
  brokenModels.streamSimple = () => {
    modelCallCount += 1;
    throw new Error("ALL_PROVIDERS_OFFLINE: should never be called for deterministic commands");
  };

  const roleModels = {
    lead: { provider: "offline-sim", modelId: "dead-model" },
    planner: { provider: "offline-sim", modelId: "dead-model" },
    coder: { provider: "offline-sim", modelId: "dead-model" },
    coderFast: { provider: "offline-sim", modelId: "dead-model" },
    reviewer: { provider: "offline-sim", modelId: "dead-model" },
    reviewerDeep: { provider: "offline-sim", modelId: "dead-model" },
    support: { provider: "offline-sim", modelId: "dead-model" },
    social: { provider: "offline-sim", modelId: "dead-model" },
    watcher: { provider: "offline-sim", modelId: "dead-model" },
    btw: { provider: "offline-sim", modelId: "dead-model" },
  };

  const daemon = await openSwarmDaemon({
    dataDir: join(rootDir, "data"),
    workspaceDir: join(rootDir, "workspace"),
    models: brokenModels,
    roleModels,
    hooks: [
      {
        id: "custom-audit-observer",
        description: "Test custom out-of-core hook",
        priority: 99,
        afterTool(_call, result) {
          return result;
        },
      },
    ],
    probeCredits: async () => [
      { name: "llmgateway", tier: "Tier 1 (Primary)", ok: false, status: "HTTP 402", latencyMs: 12, detail: "credits exhausted" },
      { name: "allmodels", tier: "Tier 2 (Cloud Failover)", ok: false, status: "HTTP 402", latencyMs: 15, detail: "credits exhausted" },
      { name: "local-llama (LFM3-1.7B-Q4_K_M)", tier: "Tier 3 (Local Failsafe)", ok: true, status: "HTTP 200", latencyMs: 2, detail: "reachable" },
    ],
  });

  try {
    const rHelp = await daemon.chat("/help");
    assert.equal(rHelp.route, "command");
    assert.equal(rHelp.deterministic, true);
    assert.equal(rHelp.llmCalls, 0);
    assert.match(rHelp.text, /Deterministic Zero-LLM Commands/);
    assert.match(rHelp.text, /\/credits/);

    const rStatus = await daemon.chat("/status");
    assert.equal(rStatus.route, "command");
    assert.equal(rStatus.llmCalls, 0);
    assert.match(rStatus.text, /offline-sim\/dead-model/);
    assert.match(rStatus.text, /0 LLM tokens/);

    const rWorkers = await daemon.chat("/workers");
    assert.equal(rWorkers.route, "command");
    assert.equal(rWorkers.llmCalls, 0);
    assert.match(rWorkers.text, /Swarm Workers/);

    const rHooks = await daemon.chat("/hooks");
    assert.equal(rHooks.route, "command");
    assert.equal(rHooks.llmCalls, 0);
    assert.match(rHooks.text, /readonly-role-guard/);
    assert.match(rHooks.text, /destructive-bash-guard/);
    assert.match(rHooks.text, /coder-hard-test-gate/);
    assert.match(rHooks.text, /custom-audit-observer/);

    const rCredits = await daemon.chat("/credits");
    assert.equal(rCredits.route, "command");
    assert.equal(rCredits.llmCalls, 0);
    assert.match(rCredits.text, /Tier 1 \(Primary\)/);
    assert.match(rCredits.text, /HTTP 402/);
    assert.match(rCredits.text, /local-llama \(LFM3-1\.7B-Q4_K_M\)/);
    assert.match(rCredits.text, /\*\*OK\*\*/);

    // Proof: zero LLM invocations occurred across all 5 slash commands!
    assert.equal(modelCallCount, 0);
  } finally {
    await daemon.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
