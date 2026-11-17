#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  GenerationTask,
  Harness,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { V3_CAVEMAN_ADHD } from "../src/prompts.mjs";
import { createFrontierModels } from "./providers.mjs";

const execFileP = promisify(execFile);

const envRaw = await readFile(new URL("../.env", import.meta.url), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

// ============================================================================
// 1. Memory Benchmark: OptMem (`VictorTaelin/OptMem` memo) vs Raw Full-Dump
// ============================================================================
async function benchOptMem() {
  const memDir = await mkdtemp(join(tmpdir(), "optmem-bench-"));
  const memoBin = "/tmp/OptMem/memo";
  const env = { ...process.env, MEMORY_DIR: memDir };

  const { stdout: initOut } = await execFileP("python3", [memoBin, "init"], { env });
  const initChars = initOut.length;
  const approxPromptTokens = Math.round(initChars / 4);

  // Seed 48 cross-session memories including 2 buried critical facts at #5 and #39
  // Whenever `memo note` requests a 1-line tree merge (`memo nap <id> "..."`), perform it as OptMem mandates!
  const notes = [];
  for (let i = 0; i < 48; i++) {
    if (i === 5) {
      notes.push("PROD_SSH_RULE: Hetzner VPS port 2222 smartcard-only; bearer tokens strictly forbidden.");
    } else if (i === 39) {
      notes.push("SUPPORT_POLICY: 1 ticket per human; forever-agent creates drafts only, never auto-sends.");
    } else {
      notes.push(`Session #${i}: routine build green on module-${i % 19}.mjs; 0 regressions.`);
    }
  }

  let napMergesRequired = 0;
  const tWrite0 = performance.now();
  for (const n of notes) {
    const { stdout: noteOut } = await execFileP("python3", [memoBin, "note", n], { env });
    // Check if OptMem emitted a pending `memo nap <lo-hi>` compression request
    let cur = noteOut;
    while (cur.includes(" nap ")) {
      const m = cur.match(/nap\s+(\d+-\d+)/);
      if (!m) break;
      napMergesRequired++;
      // Preserve critical rules in summary if present in the pair being compressed
      const hasSsh = cur.includes("PROD_SSH_RULE");
      const hasSup = cur.includes("SUPPORT_POLICY");
      const merged = [
        hasSsh ? "PROD_SSH_RULE: port 2222 smartcard-only, zero bearer tokens." : "",
        hasSup ? "SUPPORT_POLICY: 1 ticket/human, drafts only." : "",
        !hasSsh && !hasSup ? `Merged #${m[1]}: routine green builds.` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const r = await execFileP("python3", [memoBin, "nap", m[1], merged], { env });
      cur = r.stdout;
    }
  }
  const writeMs = +(performance.now() - tWrite0).toFixed(1);

  const rawDumpChars = notes.join("\n").length;
  const rawDumpApproxTokens = Math.round(rawDumpChars / 4);

  // Set WAKE_LINES=16 so wake must use the compressed binary tree!
  await execFileP("python3", [memoBin, "config", "WAKE_LINES=16"], { env });
  let wakeBlocked = false;
  let wakeOut = "";
  const tWake0 = performance.now();
  try {
    const r = await execFileP("python3", [memoBin, "wake"], { env });
    wakeOut = r.stdout;
  } catch (e) {
    // Drain any remaining naps needed for the tighter WAKE_LINES=16 budget
    wakeBlocked = true;
    let cur = e.stdout || "";
    while (cur.includes(" nap ")) {
      const m = cur.match(/nap\s+(\d+-\d+)/);
      if (!m) break;
      napMergesRequired++;
      const hasSsh = cur.includes("PROD_SSH_RULE");
      const hasSup = cur.includes("SUPPORT_POLICY");
      const merged = [
        hasSsh ? "PROD_SSH_RULE: port 2222 smartcard-only, zero bearer tokens." : "",
        hasSup ? "SUPPORT_POLICY: 1 ticket/human, drafts only." : "",
        !hasSsh && !hasSup ? `Merged #${m[1]}: routine green builds.` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const r = await execFileP("python3", [memoBin, "nap", m[1], merged], { env });
      cur = r.stdout;
    }
    const r2 = await execFileP("python3", [memoBin, "wake"], { env });
    wakeOut = r2.stdout;
  }
  const wakeMs = +(performance.now() - tWake0).toFixed(2);
  const wakeApproxTokens = Math.round(wakeOut.length / 4);

  const tRecall0 = performance.now();
  const { stdout: recallSsh } = await execFileP("python3", [memoBin, "recall", "PROD_SSH_RULE|SUPPORT_POLICY"], { env });
  const recallMs = +(performance.now() - tRecall0).toFixed(2);
  const exactHits =
    recallSsh.includes("port 2222 smartcard-only") && recallSsh.includes("never auto-sends") ? "2/2" : "0/2";

  await rm(memDir, { recursive: true, force: true });
  return {
    promptSetupChars: initChars,
    promptSetupApproxTokens: approxPromptTokens,
    seededMemories: 48,
    napMergesRequired,
    wakeBlockedWhenUncompressed: wakeBlocked,
    writeMs,
    rawDumpApproxTokens,
    wake16ApproxTokens: wakeApproxTokens,
    wakeTokenSavingsPct: +((1 - wakeApproxTokens / rawDumpApproxTokens) * 100).toFixed(1),
    wakePreservedCriticalRulesInTree:
      wakeOut.includes("PROD_SSH_RULE") && wakeOut.includes("SUPPORT_POLICY"),
    wakeLatencyMs: wakeMs,
    recallLatencyMs: recallMs,
    recallExactHits: exactHits,
  };
}

// ============================================================================
// 2. Deterministic `onYield` + `beforeTool` Gate + System-1 `jev-latest` Triage
// ============================================================================
async function benchGates() {
  // Part A: Deterministic `beforeTool` + `onYield` Verification Gate on a tricky coding bug
  const runCoder = async (withGate) => {
    const workDir = await mkdtemp(join(tmpdir(), `gate-${withGate ? "on" : "off"}-`));
    const dbFile = join(workDir, ".durable.sqlite");
    // Seed a subtly broken file where tests fail unless actually run
    await writeFile(
      join(workDir, "calc.mjs"),
      `export function splitPromptTasks(text) {\n  return text.split("\\n").filter(Boolean);\n}\n`,
    );
    await writeFile(
      join(workDir, "calc.test.mjs"),
      `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { splitPromptTasks } from "./calc.mjs";\ntest("splits numbered and bulleted tasks, ignoring code fences", () => {\n  const input = "1. Fix auth\\n\`\`\`js\\n1. inside code\\n\`\`\`\\n2. Add cron";\n  assert.deepEqual(splitPromptTasks(input), ["Fix auth", "Add cron"]);\n});\n`,
    );

    const models = createFrontierModels();
    const registry = createRegistry();
    registry.install(CodingTools);

    let blockedDestructive = false;
    let yieldContinuations = 0;

    if (withGate) {
      registry.install(
        defineExtension({
          name: "rule-gates",
          hooks: [
            hook(ToolTask, {
              beforeTool(call) {
                if (call.name === "bash" && /rm\s+-rf\s+\/|git\s+push\s+--force/.test(String(call.arguments?.command || ""))) {
                  blockedDestructive = true;
                  return { block: "Blocked by deterministic safety gate: destructive command requires human smartcard approval." };
                }
              },
            }),
            hook(GenerationTask, {
              onYield(answer) {
                const txt = (answer.content || [])
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("\n");
                if (!/Verified:\s*PASS/i.test(txt) && yieldContinuations < 2) {
                  yieldContinuations++;
                  return {
                    continue:
                      "GATE REJECTED COMPLETION: Run `node --test calc.test.mjs` via bash and include `Verified: PASS` with exact test count before finishing.",
                  };
                }
              },
            }),
          ],
        }),
      );
    }

    const storage = await openNodeSqliteStorage(dbFile);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd || workDir }),
      },
      BACKGROUND_CONTEXT,
    );

    const t0 = Date.now();
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: "llmgateway", modelId: "muse-ember-1.0" },
        thinkingLevel: "high",
        cwd: workDir,
        maxTurns: 8,
        instructions: V3_CAVEMAN_ADHD,
      },
    });

    const sub = await root.submit(
      {
        type: "input",
        content: withGate
          ? "First test running `bash` with `git push --force origin main` (expect block), then fix `calc.mjs` so `calc.test.mjs` passes."
          : "Fix `calc.mjs` so numbered tasks outside markdown code fences are returned cleanly without numbers.",
      },
      BACKGROUND_CONTEXT,
    );
    await sub.wait(BACKGROUND_CONTEXT);
    const wallSec = +((Date.now() - t0) / 1000).toFixed(2);
    const usage = await harness.usage(BACKGROUND_CONTEXT);

    let pass = false;
    try {
      await execFileP("node", ["--test", "calc.test.mjs"], { cwd: workDir });
      pass = true;
    } catch {}

    let tokens = 0, cost = 0;
    for (const u of Object.values(usage.models || {})) {
      tokens += u.totalTokens ?? 0;
      cost += u.cost?.total ?? 0;
    }

    await harness.close(BACKGROUND_CONTEXT);
    await rm(workDir, { recursive: true, force: true });
    return { withGate, pass, blockedDestructive, yieldContinuations, wallSec, tokens, costUsd: +cost.toFixed(4) };
  };

  const [noGate, gated] = await Promise.all([runCoder(false), runCoder(true)]);

  // Part B: System-1 `jev-latest` Forever-Agent Triage Benchmark (6 realistic cron/support/prompt scenarios)
  const scenarios = [
    {
      name: "nginx-scanner-noise",
      expected: "stay_silent",
      input: "LogWatcher 5m tick: 0 5xx errors, 4 hits to /wp-admin from bot IP returning 404.",
      mode: "watcher",
    },
    {
      name: "sqlite-disk-full-500",
      expected: "page_immediately",
      input: "LogWatcher 5m tick: 47 HTTP 500 errors in api.log: SQLITE_FULL: database or disk is full on /data/prod.sqlite.",
      mode: "watcher",
    },
    {
      name: "vip-support-refund-email",
      expected: "draft_only",
      input: "SupportInbox: Customer Anna writes 'I was charged twice on invoice #8841, please refund €49 immediately.'",
      mode: "watcher",
    },
    {
      name: "unrelated-3-task-user-prompt",
      expected: "fanout_parallel",
      input: "User prompt: 1) Check why Hetzner nginx rotated early, 2) write a unit test for redactSecrets, 3) draft a changelog tweet.",
      mode: "router",
    },
    {
      name: "single-coupled-refactor",
      expected: "single_agent",
      input: "User prompt: Rename `openBus` to `openAgentBus` in `src/bus.mjs` and update its import on line 4 of `src/index.mjs`.",
      mode: "router",
    },
    {
      name: "followup-question-on-current-diff",
      expected: "side_chat_readonly",
      input: "User `/btw` prompt while swarm is busy: Why did we pick `node:sqlite` instead of `better-sqlite3` in `winner-bus.mjs`?",
      mode: "router",
    },
  ];

  const tJev0 = performance.now();
  const jevCalls = await Promise.all(
    scenarios.map(async (s) => {
      const c0 = performance.now();
      const questions =
        s.mode === "watcher"
          ? [
              {
                id: "action",
                type: "choice",
                instructions:
                  "Forever-agent minimum-human-attention rule: stay_silent on routine noise; draft_only for customer support/social replies (never auto-send); page_immediately ONLY on active outage, disk full, or security breach.",
                choices: [
                  { value: "stay_silent", description: "Routine noise, bots, 404s, green checks." },
                  { value: "draft_only", description: "Customer email or non-critical issue needing a human-approved draft." },
                  { value: "page_immediately", description: "Production outage, 5xx spike, SQLITE_FULL, security incident." },
                ],
              },
            ]
          : [
              {
                id: "route",
                type: "choice",
                instructions:
                  "Orchestrator routing rule: fanout_parallel when prompt contains >=2 unrelated tasks; single_agent when tightly coupled edit on 1-2 files; side_chat_readonly when user asks a read-only `/btw` explanation while workers run.",
                choices: [
                  { value: "fanout_parallel", description: "2+ independent tasks/questions that can run concurrently in background workers." },
                  { value: "single_agent", description: "Single tightly-coupled task." },
                  { value: "side_chat_readonly", description: "Read-only `/btw` question answered without interrupting active workers." },
                ],
              },
            ];

      const res = await fetch("https://api.llmgateway.io/v1/decisions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LLMGATEWAY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "jev-latest", input: s.input, questions }),
      });
      const data = await res.json();
      const latencyMs = Math.round(performance.now() - c0);
      const picked = data?.answers?.[0]?.choice;
      const conf = data?.answers?.[0]?.confidence;
      const cost = data?.usage?.cost ?? 0;
      const tokens = data?.usage?.total_tokens ?? 0;
      return {
        scenario: s.name,
        expected: s.expected,
        picked,
        correct: picked === s.expected,
        confidence: conf,
        latencyMs,
        tokens,
        costUsd: cost,
      };
    }),
  );
  const jevBatchWallMs = Math.round(performance.now() - tJev0);
  const jevCorrect = jevCalls.filter((x) => x.correct).length;
  const jevTotalCost = +jevCalls.reduce((a, b) => a + b.costUsd, 0).toFixed(6);

  return {
    deterministicGate: { noGate, gated },
    system1JevTriage: {
      accuracy: `${jevCorrect}/${jevCalls.length}`,
      batchWallMs: jevBatchWallMs,
      avgLatencyMs: Math.round(jevCalls.reduce((a, b) => a + b.latencyMs, 0) / jevCalls.length),
      totalCostUsd: jevTotalCost,
      costPerDecisionUsd: +(jevTotalCost / jevCalls.length).toFixed(6),
      calls: jevCalls,
    },
  };
}

// ============================================================================
// 3. Real `SIGKILL` Mid-Turn Durable SQLite Crash Recovery Test
// ============================================================================
async function benchSigkillRecovery() {
  const workDir = await mkdtemp(join(tmpdir(), "sigkill-durable-"));
  const dbFile = join(workDir, "crash.sqlite");
  const childScript = new URL("./sigkill-child-tmp.mjs", import.meta.url).pathname;

  await writeFile(
    childScript,
    `import { writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createFrontierModels } from "./providers.mjs";

const mode = process.argv[2]; // "first" or "recover"
const dbFile = process.argv[3];
const workDir = process.argv[4];

const slowStepTool = defineTool({
  name: "staged_deploy_step",
  description: "Writes checkpoint.txt then sleeps 3s before returning.",
  replay: "safe",
  parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
  async execute(args) {
    await writeFile(workDir + "/checkpoint-started.txt", args.token);
    if (mode === "first") {
      console.log("READY_FOR_SIGKILL");
      await new Promise((r) => setTimeout(r, 10000));
    }
    await writeFile(workDir + "/recovered-complete.txt", args.token);
    return { output: [{ type: "text", text: "STEP_COMPLETED:" + args.token }] };
  }
});

const models = createFrontierModels();
const registry = createRegistry();
registry.install(defineExtension({ name: "crash-ext", tools: [slowStepTool] }));

const storage = await openNodeSqliteStorage(dbFile);
const harness = await Harness.open(storage, {
  models,
  registry,
  env: () => new NodeExecutionEnv({ cwd: workDir }),
}, BACKGROUND_CONTEXT);

const root = await harness.root(BACKGROUND_CONTEXT, {
  agent: {
    model: { provider: "llmgateway", modelId: "muse-ember-1.0" },
    thinkingLevel: "low",
    cwd: workDir,
    maxTurns: 4,
    instructions: "Call staged_deploy_step with token='SURVIVED_SIGKILL_99' immediately, then reply DONE.",
  }
});

if (mode === "first") {
  const sub = await root.submit({ type: "input", content: "Run staged_deploy_step with token SURVIVED_SIGKILL_99" }, BACKGROUND_CONTEXT);
  await sub.wait(BACKGROUND_CONTEXT);
} else {
  // Reopening Harness on the same SQLite DB automatically resumes interrupted ToolTask & GenerationTask!
  await root.waitForIdle(BACKGROUND_CONTEXT);
  const ctx = await root.context(BACKGROUND_CONTEXT);
  console.log("RECOVERED_ENTRIES=" + ctx.entries.length);
}
await harness.close(BACKGROUND_CONTEXT);
`,
  );

  const t0 = Date.now();
  // Spawn first process and SIGKILL (-9) the moment it enters the tool execution!
  let killed = false;
  await new Promise((resolve, reject) => {
    const child = spawn("node", [childScript, "first", dbFile, workDir], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (buf) => {
      if (buf.toString().includes("READY_FOR_SIGKILL") && !killed) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.on("exit", () => resolve());
    child.on("error", reject);
  });

  // Now spawn second process in "recover" mode WITHOUT re-submitting user input!
  const tRec0 = Date.now();
  const { stdout: recOut } = await execFileP("node", [childScript, "recover", dbFile, workDir], {
    env: process.env,
    timeout: 60_000,
  });
  const recoveryWallSec = +((Date.now() - tRec0) / 1000).toFixed(2);
  const completedToken = (await readFile(join(workDir, "recovered-complete.txt"), "utf8").catch(() => "")).trim();

  await rm(childScript, { force: true });
  await rm(workDir, { recursive: true, force: true });
  return {
    sigkillDeliveredMidTool: killed,
    autoResumedWithoutResubmit: completedToken === "SURVIVED_SIGKILL_99",
    completedToken,
    recoveryWallSec,
    totalWallSec: +((Date.now() - t0) / 1000).toFixed(2),
    stdout: recOut.trim(),
  };
}

console.log("Running Round 3: OptMem + Deterministic/System-1 Gates + SIGKILL Crash Recovery...");
const [optmem, gates, sigkill] = await Promise.all([benchOptMem(), benchGates(), benchSigkillRecovery()]);

const summary = { optmem, gates, sigkill };
await writeFile(new URL("./results-round3-arch.json", import.meta.url), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
