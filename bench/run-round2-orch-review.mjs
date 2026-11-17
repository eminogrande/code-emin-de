#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { V3_CAVEMAN_ADHD } from "../src/prompts.mjs";
import { openAgentBus } from "./winner-bus.mjs";
import { createFrontierModels } from "./providers.mjs";

const SwarmStateDoc = defineDoc({
  kind: "bench.swarm",
  version: 1,
  scope: "session",
  initial: () => ({ spawned: [], completed: [], reviewVerdicts: [] }),
  checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 16,
});

function extractText(entry) {
  const msg = entry?.model?.[0];
  if (!msg || !Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function buildOrchestrationExtension({ bus, workDir, workerModel, reviewerModel }) {
  const spawnWorkerTool = defineTool({
    name: "spawn_worker",
    description:
      "Spawn an isolated background worker conversation for ONE independent subtask. Returns immediately with workerId & conversationId without blocking.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        workerId: { type: "string", description: "Short unique worker id, e.g. 'w-cron' or 'w-retry'" },
        role: { type: "string", enum: ["coder", "researcher"], description: "Worker role" },
        brief: { type: "string", description: "Self-contained instructions for this worker, including any bus coordination rules" },
      },
      required: ["workerId", "role", "brief"],
    },
    async execute(args, api, context) {
      const createdAt = Date.now();
      let convId;
      await api.commit(async (tx) => {
        const c = await tx.createConversation({
          ownership: { kind: "ownerless" },
        });
        convId = c.id;
        const draft = await tx.doc(SwarmStateDoc);
        draft.spawned.push({ workerId: args.workerId, role: args.role, convId, createdAt });
      }, context);

      const handle = await api.conversation(convId, context);
      // Configure worker conversation with CodingTools + bus tools, using fast workerModel
      // Note: ConversationHandle in ToolExecutionApi submits directly; we set agent config via tx or host default
      await handle.submit(
        {
          type: "input",
          content: `[WORKER_ID=${args.workerId}]\nWorking directory: ${workDir}\n${args.brief}`,
        },
        context,
      );
      return {
        output: [{ type: "text", text: JSON.stringify({ spawned: true, workerId: args.workerId, conversationId: convId, createdAt }) }],
      };
    },
  });

  const busSendTool = defineTool({
    name: "bus_send",
    description: "Send a message on the shared SQLite AgentBus to another workerId or '*' broadcast.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        topic: { type: "string" },
        body: { type: "string" },
      },
      required: ["from", "to", "topic", "body"],
    },
    async execute(args) {
      const msg = bus.send(args);
      return { output: [{ type: "text", text: JSON.stringify(msg) }] };
    },
  });

  const busInboxTool = defineTool({
    name: "bus_inbox",
    description: "Check unread or all messages on the shared SQLite AgentBus for agentId, or search by topic/keyword.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        unreadOnly: { type: "boolean" },
        searchQuery: { type: "string" },
      },
      required: ["agentId"],
    },
    async execute(args) {
      const rows = args.searchQuery
        ? bus.search(args.searchQuery)
        : bus.inbox(args.agentId, { unreadOnly: args.unreadOnly ?? false });
      return { output: [{ type: "text", text: JSON.stringify(rows) }] };
    },
  });

  return defineExtension({
    name: "swarm-bus",
    tools: [spawnWorkerTool, busSendTool, busInboxTool],
  });
}

// ============================================================================
// TEST A: Multi-Prompt Non-Blocking Fan-Out + Sibling Cross-Agent Bus Comms
// ============================================================================
const MULTI_PROMPT = `Handle all 3 items in this single message WITHOUT blocking me:
1. Build \`./parse-duration.mjs\` exporting \`parseDurationMs(str)\` supporting \`ms\`, \`s\`, \`m\`, \`h\`, \`d\` (including decimals like \`"1.5h"\` and compound \`"1h30m"\`, throwing \`RangeError\` on invalid/negative input) AND post the exact exported function signature to \`w-limiter\` on the agent bus under topic \`duration-api\`.
2. Build \`./rate-limiter.mjs\` exporting \`createWindowLimiter({ max, window })\` that imports \`parseDurationMs\` from \`./parse-duration.mjs\` (check your \`bus_inbox\` for \`w-limiter\` or search \`duration-api\` to confirm the exact signature from the sibling worker!). Return \`{ allow(key, now = Date.now()): boolean }\`.
3. Build \`./redact-secrets.mjs\` exporting \`redactSecrets(text)\` that replaces \`sk-*\`, \`ghp_*\`, \`gho_*\`, \`llmgtwy_*\`, and \`Bearer <token>\` with \`[REDACTED]\` while leaving normal words untouched.

CRITICAL ORCHESTRATOR RULES:
- Do NOT write any of these 3 files yourself! Spawn 3 parallel background workers (\`w-duration\`, \`w-limiter\`, \`w-redact\`) in this turn using \`spawn_worker\` so all 3 run concurrently, then immediately reply to me in <=3 lines confirming the 3 spawned worker IDs so I can keep chatting while they work.`;

async function testLeadFanout(leadCandidate, workerCandidate) {
  const workDir = await mkdtemp(join(tmpdir(), `fanout-${leadCandidate.modelId.replace(/[^a-z0-9]/gi, "_")}-`));
  const dbFile = join(workDir, ".durable.sqlite");
  const busFile = join(workDir, ".bus.sqlite");
  const bus = openAgentBus(busFile);
  const models = createFrontierModels();
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(buildOrchestrationExtension({ bus, workDir, workerModel: workerCandidate }));

  let harness;
  const t0 = Date.now();
  let leadTurnSec = 0;
  let totalWallSec = 0;
  let spawnedList = [];
  let leadWroteFilesItself = false;
  let busCoordUsed = false;
  let passSuite = 0;
  let usage = null;
  let errStr = null;

  try {
    const storage = await openNodeSqliteStorage(dbFile);
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          toolExecution: "parallel",
          retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
        },
        conversationCreated: async (tx, conv) => {
          if (conv.id !== 1) {
            await configure(tx, conv.id, {
              model: { provider: workerCandidate.provider, modelId: workerCandidate.modelId },
              thinkingLevel: "high",
              cwd: workDir,
              maxTurns: 12,
              instructions: V3_CAVEMAN_ADHD,
            });
          }
        },
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd || workDir }),
      },
      BACKGROUND_CONTEXT,
    );

    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: leadCandidate.provider, modelId: leadCandidate.modelId },
        thinkingLevel: "high",
        cwd: workDir,
        maxTurns: 6,
        // Lead only gets spawn_worker + bus_inbox + bus_send so it CANNOT waste time coding solo, or we keep CodingTools to test discipline!
        // Let's keep ALL tools enabled to genuinely test whether the Lead obeys delegation vs coding itself!
      },
    });

    const sub = await root.submit({ type: "input", content: MULTI_PROMPT }, BACKGROUND_CONTEXT);
    const settled = await Promise.race([
      sub.wait(BACKGROUND_CONTEXT),
      new Promise((_, rej) => setTimeout(() => rej(new Error("LEAD_TIMEOUT_90S")), 90_000)),
    ]);
    leadTurnSec = +((Date.now() - t0) / 1000).toFixed(2);

    // Check if Lead tried to call write/edit/bash itself!
    const rootCtx = await root.context(BACKGROUND_CONTEXT);
    for (const e of rootCtx.entries) {
      if (e.kind === "pi.assistant") {
        const blocks = e.model?.[0]?.content || [];
        for (const b of blocks) {
          if (b.type === "toolCall" && ["write", "edit", "bash"].includes(b.name)) {
            leadWroteFilesItself = true;
          }
        }
      }
    }

    // Read spawned worker conversations and configure/wait for them to finish in parallel!
    const state = (await harness.snapshot(SwarmStateDoc, BACKGROUND_CONTEXT)) ?? { spawned: [] };
    spawnedList = state.spawned || [];

    await Promise.all(
      spawnedList.map(async (w) => {
        const c = await harness.conversation(w.convId, BACKGROUND_CONTEXT);
        if (c) {
          await Promise.race([
            c.waitForIdle(BACKGROUND_CONTEXT),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`WORKER_TIMEOUT_${w.workerId}`)), 120_000)),
          ]);
        }
      }),
    );

    totalWallSec = +((Date.now() - t0) / 1000).toFixed(2);
    usage = await harness.usage(BACKGROUND_CONTEXT);

    // Check AgentBus messages!
    const busMsgs = [
      ...bus.inbox("w-limiter", { unreadOnly: false }),
      ...bus.search("duration"),
      ...bus.search("parseDurationMs"),
    ];
    busCoordUsed = busMsgs.length > 0;

    // Run independent verification tests on all 3 generated modules!
    const verifyCode = `import test from "node:test";
import assert from "node:assert/strict";
import { parseDurationMs } from "./parse-duration.mjs";
import { createWindowLimiter } from "./rate-limiter.mjs";
import { redactSecrets } from "./redact-secrets.mjs";

test("1. parseDurationMs", () => {
  assert.equal(parseDurationMs("500ms"), 500);
  assert.equal(parseDurationMs("1.5h"), 5400000);
  assert.equal(parseDurationMs("1h30m"), 5400000);
  assert.throws(() => parseDurationMs("-5s"), RangeError);
  assert.throws(() => parseDurationMs("abc"), RangeError);
});

test("2. createWindowLimiter using parseDurationMs", () => {
  const lim = createWindowLimiter({ max: 2, window: "10s" });
  assert.equal(lim.allow("u1", 1000), true);
  assert.equal(lim.allow("u1", 2000), true);
  assert.equal(lim.allow("u1", 3000), false);
  assert.equal(lim.allow("u2", 3000), true);
  assert.equal(lim.allow("u1", 12001), true);
});

test("3. redactSecrets", () => {
  const s = "Keys: sk-1234567890abcdef, ghp_ABCDEF1234567890, llmgtwy_XYZ987654321, Authorization: Bearer my-secret-tok. Keep word skill.";
  const r = redactSecrets(s);
  assert.ok(!r.includes("1234567890abcdef"));
  assert.ok(!r.includes("ABCDEF1234567890"));
  assert.ok(!r.includes("XYZ987654321"));
  assert.ok(!r.includes("my-secret-tok"));
  assert.ok(r.includes("skill"));
});
`;
    await writeFile(join(workDir, "verify-fanout.test.mjs"), verifyCode);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    try {
      const { stdout, stderr } = await promisify(execFile)("node", ["--test", "verify-fanout.test.mjs"], {
        cwd: workDir,
        timeout: 10_000,
      });
      const out = stdout + stderr;
      const m = out.match(/ℹ pass (\d+)/);
      passSuite = m ? Number(m[1]) : 3;
    } catch (testErr) {
      const out = (testErr?.stdout || "") + "\n" + (testErr?.stderr || "");
      const m = out.match(/ℹ pass (\d+)/);
      passSuite = m ? Number(m[1]) : 0;
      errStr = out.slice(-220).replace(/\s+/g, " ").trim();
    }
  } catch (e) {
    errStr = e?.message || String(e);
  } finally {
    try { bus.close(); } catch {}
    try { if (harness) await harness.close(BACKGROUND_CONTEXT); } catch {}
    await rm(workDir, { recursive: true, force: true });
  }

  let totalTokens = 0, costUsd = 0;
  if (usage?.models) {
    for (const u of Object.values(usage.models)) {
      totalTokens += u.totalTokens ?? 0;
      costUsd += u.cost?.total ?? 0;
    }
  }

  // Score out of 5:
  // +1 spawned === 3 workers
  // +1 !leadWroteFilesItself (true non-blocking delegation)
  // +1 leadTurnSec < 25s (user didn't wait forever!)
  // +1 busCoordUsed (workers talked over SQLite AgentBus)
  // +3 passSuite (3 functional module tests) -> total out of 7
  const score =
    (spawnedList.length === 3 ? 1 : 0) +
    (!leadWroteFilesItself ? 1 : 0) +
    (busCoordUsed ? 1 : 0) +
    passSuite;

  return {
    lead: leadCandidate.label,
    worker: workerCandidate.label,
    score: `${score}/6`,
    scoreNum: score,
    spawned: spawnedList.length,
    leadSoloViolation: leadWroteFilesItself,
    busCoordUsed,
    modulesGreen: `${passSuite}/3`,
    leadTurnSec,
    totalWallSec,
    totalTokens,
    costUsd: +costUsd.toFixed(4),
    error: errStr,
  };
}

// ============================================================================
// TEST B: Adversarial Code Review Gate (Planted Subtle Security/Edge-Case Bugs)
// ============================================================================
const BUGGY_CODE = `// Cron & Approval Gate module with 4 planted subtle production bugs:
// Bug 1: checkApproval uses string startsWith("/workspace/safe") without path.resolve, allowing "/workspace/safe/../../etc/passwd" path traversal!
// Bug 2: verifyHmac compares signatures with === instead of crypto.timingSafeEqual (and throws if buffer lengths differ).
// Bug 3: nextIntervalRun(lastRunMs, everyMs, nowMs) loops step-by-step from lastRunMs, hanging the event loop if everyMs === 0 or negative, or taking millions of iterations after long downtime.
// Bug 4: dedupeEvent(seenMap, id, ttlMs, nowMs) never evicts expired entries OR treats timestamp 0 as falsy.

export function isSafeWorkspacePath(targetPath) {
  return typeof targetPath === "string" && targetPath.startsWith("/workspace/safe/");
}

export function verifyWebhookSignature(rawBody, secret, hexSig) {
  // planted bug: naive string equality + wrong hmac
  return hexSig === secret;
}

export function nextIntervalRun(lastRunMs, everyMs, nowMs) {
  let next = lastRunMs;
  while (next <= nowMs) next += everyMs;
  return next;
}

export function shouldProcessEvent(seenMap, eventId, ttlMs, nowMs) {
  const prev = seenMap.get(eventId);
  if (prev && nowMs - prev < ttlMs) return false;
  seenMap.set(eventId, nowMs);
  return true;
}
`;

const REVIEW_PROMPT = `Review \`./gate.mjs\` strictly as a production security & reliability reviewer before deployment.
Do NOT edit files. Inspect \`./gate.mjs\` and list EVERY concrete bug/vulnerability you find with exact function name and root cause. End with VERDICT: REQUEST_CHANGES or VERDICT: APPROVE.`;

async function testReviewer(reviewerCandidate) {
  const workDir = await mkdtemp(join(tmpdir(), `rev-${reviewerCandidate.modelId.replace(/[^a-z0-9]/gi, "_")}-`));
  // Strip the top comment before writing so the reviewer cannot read our cheat-sheet comments!
  const cleanBuggyCode = BUGGY_CODE.split("\n").filter((l) => !l.startsWith("//")).join("\n").trim() + "\n";
  await writeFile(join(workDir, "gate.mjs"), cleanBuggyCode);

  const dbFile = join(workDir, ".durable.sqlite");
  const models = createFrontierModels();
  const registry = createRegistry();
  registry.install(CodingTools);

  const t0 = Date.now();
  let harness;
  let answerText = "";
  let usage = null;
  let errStr = null;

  try {
    const storage = await openNodeSqliteStorage(dbFile);
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd || workDir }),
      },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: reviewerCandidate.provider, modelId: reviewerCandidate.modelId },
        thinkingLevel: "high",
        cwd: workDir,
        maxTurns: 6,
      },
    });
    const sub = await root.submit({ type: "input", content: REVIEW_PROMPT }, BACKGROUND_CONTEXT);
    const settled = await Promise.race([
      sub.wait(BACKGROUND_CONTEXT),
      new Promise((_, rej) => setTimeout(() => rej(new Error("REVIEW_TIMEOUT_90S")), 90_000)),
    ]);
    if (settled.status === "done") {
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
      answerText = extractText(entry);
    }
    usage = await harness.usage(BACKGROUND_CONTEXT);
  } catch (e) {
    errStr = e?.message || String(e);
  } finally {
    try { if (harness) await harness.close(BACKGROUND_CONTEXT); } catch {}
    await rm(workDir, { recursive: true, force: true });
  }

  const wallSec = +((Date.now() - t0) / 1000).toFixed(2);
  const low = answerText.toLowerCase();
  // Deterministic check for all 5 real issues in cleanBuggyCode:
  const c1 = /traversal|\.\.|resolve|normalize/.test(low); // path traversal
  const c2 = /hmac|createhmac|sha256/.test(low) && /timingsafeequal|constant[- ]time|timing/.test(low); // real HMAC + timing-safe
  const c3 = /(everyms\s*<=?\s*0|infinite loop|zero|negative|non-positive)/.test(low); // infinite loop when everyMs <= 0
  const c4 = /(prev\s*===\s*0|nowms\s*===\s*0|falsy|prev !== undefined|has\()/.test(low) || /(unbounded|evict|memory leak|cleanup|grow)/.test(low);
  const c5 = /request_changes/.test(low);

  const caught = [c1, c2, c3, c4, c5].filter(Boolean).length;
  let totalTokens = 0, costUsd = 0;
  if (usage?.models) {
    for (const u of Object.values(usage.models)) {
      totalTokens += u.totalTokens ?? 0;
      costUsd += u.cost?.total ?? 0;
    }
  }

  return {
    reviewer: reviewerCandidate.label,
    caught: `${caught}/5`,
    caughtNum: caught,
    details: { pathTraversal: c1, hmacTimingSafe: c2, infiniteLoopEveryMs: c3, mapLeakOrZeroTs: c4, verdictRequestChanges: c5 },
    wallSec,
    totalTokens,
    costUsd: +costUsd.toFixed(4),
    error: errStr,
  };
}

// Load .env
const envRaw = await readFile(new URL("../.env", import.meta.url), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const CONTENDERS = [
  { provider: "llmgateway", modelId: "kimi-k3.1-pro", label: "Kimi K3.1 Pro" },
  { provider: "llmgateway", modelId: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { provider: "llmgateway", modelId: "deepseek-v4.1-flash-uncensored", label: "DeepSeek V4.1 Flash Uncensored" },
  { provider: "allmodels", modelId: "deepseek/deepseek-v4.1-flash-abliterated", label: "DeepSeek V4.1 Flash Abliterated (AllModels)" },
  { provider: "llmgateway", modelId: "deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash 1017" },
  { provider: "llmgateway", modelId: "mistral-large-4", label: "Mistral Large 4 (open-weights)" },
  { provider: "llmgateway", modelId: "qwen3.8-2.4t-a95b", label: "Qwen3.8 2.4T A95B (open-weights)" },
  { provider: "llmgateway", modelId: "qwen4-max", label: "Qwen4 Max" },
  { provider: "llmgateway", modelId: "glm-5.3", label: "GLM-5.3" },
  { provider: "llmgateway", modelId: "minimax-m3.1-flash", label: "MiniMax M3.1 Flash" },
  { provider: "llmgateway", modelId: "muse-wonder-1.0", label: "Meta Muse Wonder 1.0" },
  { provider: "llmgateway", modelId: "muse-ember-1.0", label: "Meta Muse Ember 1.0" },
  { provider: "llmgateway", modelId: "muse-spark-open", label: "Meta Muse Spark Open (816B, open-weights)" },
  { provider: "llmgateway", modelId: "fugu-max", label: "Sakana Fugu Max" },
];

const FAST_WORKER = { provider: "llmgateway", modelId: "deepseek-v4.1-flash-uncensored", label: "DeepSeek V4.1 Flash Uncensored" };

const mode = process.argv[2] || "all"; // "review", "fanout", "single-fanout", "all"
const singleModel = process.argv[3];

let revResults = [];
if (mode === "all" || mode === "review") {
  console.log("=== ROUND 2A: Adversarial Security & Edge-Case Review Benchmark (batches of 4) ===");
  for (let i = 0; i < CONTENDERS.length; i += 4) {
    const part = await Promise.all(CONTENDERS.slice(i, i + 4).map((c) => testReviewer(c)));
    revResults.push(...part);
  }
  revResults.sort((a, b) => b.caughtNum - a.caughtNum || a.wallSec - b.wallSec);
  for (const r of revResults) {
    console.log(
      `[${r.caught}] ${r.reviewer.padEnd(34)} | ${String(r.wallSec).padStart(6)}s | tok=${String(r.totalTokens).padStart(6)} | $${r.costUsd.toFixed(4)} | ${JSON.stringify(r.details)}`,
    );
  }
} else {
  try {
    const prev = JSON.parse(await readFile(new URL("./results-round2-orch-review.json", import.meta.url), "utf8"));
    revResults = prev.review || [];
  } catch {}
}

const fanoutResults = [];
if (mode === "all" || mode === "fanout" || mode === "single-fanout") {
  console.log("\n=== ROUND 2B: Multi-Prompt Non-Blocking Lead Orchestration + Cross-Agent Bus Fan-Out ===");
  const list = singleModel ? CONTENDERS.filter((c) => c.modelId.includes(singleModel)) : CONTENDERS;
  for (let i = 0; i < list.length; i += 5) {
    const batch = list.slice(i, i + 5);
    const part = await Promise.all(batch.map((lead) => testLeadFanout(lead, FAST_WORKER)));
    for (const r of part) {
      fanoutResults.push(r);
      console.log(
        `[${r.score}] Lead=${r.lead.padEnd(32)} | leadTurn=${String(r.leadTurnSec).padStart(5)}s | allDone=${String(r.totalWallSec).padStart(6)}s | spawned=${r.spawned} | soloViolation=${r.leadSoloViolation} | bus=${r.busCoordUsed} | green=${r.modulesGreen} | tok=${r.totalTokens} | $${r.costUsd.toFixed(4)}${r.error ? " ERR:" + r.error : ""}`,
      );
    }
  }
}

if (mode !== "single-fanout") {
  await writeFile(
    new URL("./results-round2-orch-review.json", import.meta.url),
    JSON.stringify({ review: revResults, fanout: fanoutResults }, null, 2),
  );
  console.log("\nSaved bench/results-round2-orch-review.json");
}
