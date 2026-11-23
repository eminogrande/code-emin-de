import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SELF_REPO_DIR = process.env.SWARM_SELF_REPO || "/opt/pi-durable-swarm";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  ToolTask,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openAgentBus } from "./bus.mjs";
import { handleDeterministicCommand, probeProviderHealth } from "./commands.mjs";
import { createBuiltinGuardHooks, HookRegistry } from "./hooks.mjs";
import { decodeImage, imageId, sanitizeCorruptDurableImages } from "./image-util.mjs";
import { createOpenModels, resolveLeadModelChoice, ROLE_MODELS, ROLE_THINKING } from "./models.mjs";
import { createOptMem } from "./optmem.mjs";
import {
  AGENT_PRESETS,
  DEFAULT_ORCHESTRATION_ID,
  MIN_WORKER_INTERVAL_MS,
  nextRunAt,
  publicOrchestration,
  validateOrchestrationInput,
  validateWorkerInput,
} from "./orchestrations.mjs";
import { ROLE_INSTRUCTIONS } from "./prompts.mjs";
import { classifyUserPrompt, triageWatcherEvent } from "./triage.mjs";
import { createSupervisor, SUPERVISOR_DEFAULTS } from "./supervisor.mjs";
import { describeWorker, sortWorkers } from "./worker-meta.mjs";

export const SwarmDoc = defineDoc({
  kind: "swarm.registry",
  version: 1,
  scope: "session",
  initial: () => ({
    workers: {},
    drafts: {}, // keyed by `${channel}:${humanKey}` -> enforces 1 ticket/draft per human on support!
    alerts: [],
    approvals: [],
    cronJobs: {},
    orchestrations: {}, // named durable Lead conversations; workers point back by orchestrationId
    leadModelOverride: null, // { provider, modelId } from the chat model dropdown (allowlisted only)
  }),
  checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 16,
});

// Durable auto-continue supervisor defaults: only `turn_limit` is retried, `auth`/`billing`/`policy` never.
const RETRYABLE_FAILURES = new Set(["turn_limit"]);

export const RoleMetaDoc = defineDoc({
  kind: "swarm.role",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ role: "lead", workerId: "lead", orchestrationId: DEFAULT_ORCHESTRATION_ID, requireVerified: false }),
  checkpointWhen: () => true,
});

export function extractAssistantText(entryOrMsg) {
  const msg = Array.isArray(entryOrMsg?.model) ? entryOrMsg.model[0] : entryOrMsg;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content.trim();
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b) => b.type === "text" || typeof b === "string")
    .map((b) => (typeof b === "string" ? b : b.text || ""))
    .join("\n")
    .trim();
}

export function extractAssistantThinking(entryOrMsg) {
  const msg = Array.isArray(entryOrMsg?.model) ? entryOrMsg.model[0] : entryOrMsg;
  if (!msg || !Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b) => b && b.type === "thinking" && typeof b.thinking === "string")
    .map((b) => b.thinking)
    .join("\n")
    .trim();
}

export function extractAssistantToolCalls(entryOrMsg) {
  const msg = Array.isArray(entryOrMsg?.model) ? entryOrMsg.model[0] : entryOrMsg;
  if (!msg || !Array.isArray(msg.content)) return [];
  return msg.content
    .filter((b) => b && b.type === "toolCall")
    .map((b) => `${b.name}(${JSON.stringify(b.arguments || {})})`);
}

export function summarizeLiveProgress(live) {
  if (!live || (!live.run && !live.generation && !live.tools?.length)) return null;
  const msg = live.generation?.message;
  const thinking = extractAssistantThinking(msg);
  const text = extractAssistantText(msg);
  const toolCalls = extractAssistantToolCalls(msg);
  const tools = (live.tools || []).map((t) => ({
    callId: String(t.callId || ""),
    name: String(t.name || ""),
    status: String(t.status || "pending"),
    ...(t.output ? { output: String(t.output).slice(-1200) } : {}),
  }));
  return {
    running: Boolean(live.run),
    turns: Number(live.run?.turns) || 0,
    ...(thinking ? { thinking } : {}),
    ...(text ? { text } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

function roleToolSet(role, preset) {
  return roleToolNames(role, preset).map((name) => ({ name }));
}

function roleToolNames(role, preset = "custom") {
  switch (role) {
    case "lead":
      return [
        "spawn_worker",
        "list_workers",
        "list_agents",
        "ask_agent",
        "read_sibling",
        "bus_send",
        "bus_inbox",
        "memory_wake",
        "memory_note",
        "memory_recall",
        "list_drafts",
        "schedule_forever_agent",
        "read",
        "write",
        "edit",
        "bash",
      ];
    case "orchestrator":
      if (preset === "security") {
        return [
          "spawn_worker",
          "list_workers",
          "list_agents",
          "ask_agent",
          "read_sibling",
          "bus_send",
          "bus_inbox",
          "memory_recall",
          "request_review",
          "read",
          "bash",
        ];
      }
      if (preset === "marketing") {
        return [
          "spawn_worker",
          "list_workers",
          "list_agents",
          "ask_agent",
          "read_sibling",
          "bus_send",
          "bus_inbox",
          "memory_recall",
          "save_draft",
          "list_drafts",
          "schedule_forever_agent",
          "read",
        ];
      }
      return [
        "spawn_worker",
        "list_workers",
        "list_agents",
        "ask_agent",
        "read_sibling",
        "bus_send",
        "bus_inbox",
        "memory_wake",
        "memory_recall",
        "save_draft",
        "list_drafts",
        "schedule_forever_agent",
        "request_review",
        "read",
        "write",
        "edit",
        "bash",
      ];
    case "coder":
      return ["read", "write", "edit", "bash", "bus_send", "bus_inbox", "read_sibling", "request_review"];
    case "reviewer":
    case "planner":
      return ["read", "bash", "bus_send", "bus_inbox", "read_sibling"];
    case "support":
    case "social":
      return ["read", "bus_inbox", "bus_send", "read_sibling", "save_draft", "list_drafts"];
    case "watcher":
      return ["read", "bash", "bus_send", "bus_inbox", "save_draft"];
    case "btw":
      return ["read", "bus_inbox", "read_sibling", "list_workers", "list_drafts", "memory_recall"];
    default:
      return ["read", "bus_inbox", "read_sibling"];
  }
}

function buildOrchestrationInstructions({ id, name, preset, cwd, repoUrl, instructions }) {
  const presetInfo = AGENT_PRESETS[preset] || AGENT_PRESETS.custom;
  const lines = [
    ROLE_INSTRUCTIONS.lead,
    `- AGENT_ORCHESTRATOR=${id} (${name}) | PRESET=${preset} (${presetInfo.label}) | CWD=${cwd}`,
    `- Scope: own only this agent/domain. Spawned workers inherit CWD=${cwd}. Use \`list_agents\` and \`ask_agent\` to coordinate with other specialist agents (e.g. security-review-agent, marketers, repo owners).`,
  ];
  if (repoUrl) lines.push(`- Git Repository: ${repoUrl}. Verify build/tests before pushing; never force-push or run \`swarm-ctl\`.`);
  if (preset === "marketing") {
    lines.push("- Marketing Policy: strictly DRAFT-ONLY. Save every post/campaign/reply with `save_draft`; never publish externally.");
  } else if (preset === "security") {
    lines.push("- Security Policy: strictly READ-ONLY audit agent. Never edit files; report concrete file/line findings and severities.");
  } else if (preset === "repo") {
    lines.push("- Repo Policy: work inside CWD, run repo checks/tests, commit cleanly, and push non-force to GitHub when requested so GitHub Actions deploys.");
  }
  if (instructions) lines.push(`\nCustom Agent Brief:\n${instructions}`);
  return lines.join("\n");
}

export async function openSwarmDaemon({
  dataDir,
  workspaceDir,
  models = createOpenModels(),
  roleModels = ROLE_MODELS,
  triageOpts = {},
  supervisor: supervisorOverride = {},
  retry: retryOverride = { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
  streamTimeoutMs = 120_000,
  hooks: customHooks = [],
  probeCredits = probeProviderHealth,
} = {}) {
  const supervisorOpts = { ...SUPERVISOR_DEFAULTS, ...supervisorOverride };
  if (!dataDir || !workspaceDir) throw new Error("openSwarmDaemon requires dataDir and workspaceDir");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const dbPath = join(dataDir, "durable.sqlite");
  sanitizeCorruptDurableImages(dbPath);
  const busPath = join(dataDir, "bus.sqlite");
  const memoryDir = join(dataDir, "optmem");

  const bus = openAgentBus(busPath);
  const optmem = createOptMem({ memoryDir, wakeLines: 48 });
  await optmem.init();

  let harnessRef = null;
  const yieldRetries = new Map(); // convId -> count

  // Durable Forever-Agent Task (`sleepUntil` state machine — 0 tokens when Jev says `stay_silent`)
  const ForeverWatchTask = defineTask({
    name: "swarm.forever_watch",
    version: 1,
    initial: (input) => ({ phase: "tick", ticks: 0, lastOffset: 0, jobId: input.jobId }),
    phases: {
      async tick(task, runtime, context) {
        const { jobId, kind, sourcePath, everyMs, humanKeyField } = task.input;
        const cp = task.state.checkpoint;
        const now = runtime.now();
        let rawEvent = "";
        let nextOffset = cp.lastOffset || 0;

        if (sourcePath) {
          try {
            const full = await readFile(sourcePath, "utf8");
            if (full.length > nextOffset) {
              rawEvent = full.slice(nextOffset).trim();
            }
            nextOffset = full.length;
          } catch {}
        } else {
          const unread = bus.inbox(`watcher:${jobId}`, { unreadOnly: true });
          for (const m of unread) bus.ack(`watcher:${jobId}`, m.id);
          rawEvent = unread.map((m) => `[${m.from}] ${m.topic}: ${m.body}`).join("\n");
        }

        if (rawEvent) {
          const decision = await triageWatcherEvent(kind, rawEvent, triageOpts);
          if (decision.action === "page_immediately") {
            bus.send({ from: `watcher:${jobId}`, to: "lead", topic: "ALERT_CRITICAL", body: rawEvent });
            await runtime.commit(async (tx) => {
              const doc = await tx.doc(SwarmDoc);
              doc.alerts.push({ jobId, kind, at: now, severity: "critical", summary: rawEvent.slice(0, 500) });
              doc.cronJobs[jobId] = { ...(doc.cronJobs[jobId] || {}), lastAction: "page_immediately", lastEventAction: "page_immediately", lastTickAt: now };
            }, context);
          } else if (decision.action === "draft_only") {
            // Spawn/reuse draft-only worker (never auto-sends!)
            const role = kind === "support" ? "support" : kind === "social" ? "social" : "watcher";
            let convId;
            const workerId = `auto-${jobId}-${(cp.ticks || 0) + 1}`;
            const mRef = roleModels[role] || roleModels.watcher;
            await runtime.commit(async (tx) => {
              const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
              convId = c.id;
              await configure(tx, convId, {
                model: mRef,
                thinkingLevel: ROLE_THINKING[role] || "low",
                cwd: workspaceDir,
                maxTurns: 6,
                tools: roleToolSet(role),
                instructions: ROLE_INSTRUCTIONS[role],
              });
              const rDoc = await tx.doc(RoleMetaDoc, convId);
              rDoc.role = role;
              rDoc.workerId = workerId;
              rDoc.requireVerified = false;
              const sDoc = await tx.doc(SwarmDoc);
              sDoc.workers[workerId] = { workerId, role, convId, createdAt: now, status: "running" };
              sDoc.cronJobs[jobId] = { ...(sDoc.cronJobs[jobId] || {}), lastAction: "draft_only", lastEventAction: "draft_only", lastTickAt: now };
            }, context);
            const h = await runtime.conversation(convId, context);
            if (h) {
              await h.submit(
                {
                  type: "input",
                  content: `Handle incoming ${kind} event and store a human-reviewable draft via \`save_draft\` (1 ticket per human${humanKeyField ? `, key by ${humanKeyField}` : ""}; NEVER send externally):\n\n${rawEvent}`,
                },
                context,
              );
            }
          } else {
            await runtime.commit(async (tx) => {
              const sDoc = await tx.doc(SwarmDoc);
              sDoc.cronJobs[jobId] = { ...(sDoc.cronJobs[jobId] || {}), lastAction: "stay_silent", lastEventAction: "stay_silent", lastTickAt: now };
            }, context);
          }
        } else {
          await runtime.commit(async (tx) => {
            const sDoc = await tx.doc(SwarmDoc);
            sDoc.cronJobs[jobId] = { ...(sDoc.cronJobs[jobId] || {}), lastAction: "idle_empty", lastTickAt: now };
          }, context);
        }

        const safeEvery = Math.max(250, Number(everyMs) || 60_000);
        await runtime.sleepUntil(
          now + safeEvery,
          { phase: "tick", ticks: (cp.ticks || 0) + 1, lastOffset: nextOffset, jobId },
          context,
        );
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

  // Durable recurring worker: permanent conversation, zero-token sleep between runs.
  // A busy worker is skipped rather than queued, preventing unbounded overlapping submissions.
  const ForeverWorkTask = defineTask({
    name: "swarm.forever_work",
    version: 1,
    initial: (input) => ({ phase: "tick", runs: 0, workerId: input.workerId }),
    phases: {
      async tick(task, runtime, context) {
        const { workerId } = task.input;
        const now = runtime.now();
        const swarm = (await runtime.snapshot(SwarmDoc, context)) || { workers: {} };
        const worker = swarm.workers?.[workerId];
        if (!worker) return runtime.commit(() => ({ status: "terminal", outcome: { status: "done", reason: "worker_missing" } }), context);
        const everyMs = Math.max(MIN_WORKER_INTERVAL_MS, Number(worker.everyMs) || 60_000);
        let runs = task.state.checkpoint.runs || 0;
        if (worker.enabled === false) {
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(SwarmDoc);
            if (doc.workers[workerId]) doc.workers[workerId].lastAction = "paused";
          }, context);
          return runtime.sleepUntil(now + everyMs, { phase: "tick", runs: task.state.checkpoint.runs || 0, workerId }, context);
        }
        const live = await runtime.snapshot(LiveDoc, worker.convId, context);
        if (live?.run) {
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(SwarmDoc);
            if (doc.workers[workerId]) doc.workers[workerId].lastAction = "skipped_overlap";
          }, context);
        } else {
          runs += 1;
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(SwarmDoc);
            const w = doc.workers[workerId];
            if (w) Object.assign(w, { lastRunAt: now, lastAction: "submitted", runCount: (w.runCount || 0) + 1 });
          }, context);
          const conv = await runtime.conversation(worker.convId, context);
          if (conv) {
            await conv.submit({
              type: "input",
              content: `[RECURRING RUN ${runs} | ORCHESTRATION=${worker.orchestrationId} | WORKER=${workerId}]\n${worker.goal}\n\nPerform this run now. Keep prior conversation context; do not repeat completed work unless the goal requires it.`,
            }, context);
          }
        }
        await runtime.sleepUntil(now + everyMs, { phase: "tick", runs, workerId }, context);
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

  // Read full non-truncated transcript of any sibling conversation
  async function readConversationTranscript(convId, maxEntries = 40) {
    if (!harnessRef) return [];
    const conv = await harnessRef.conversation(convId, BACKGROUND_CONTEXT);
    if (!conv) return [];
    const ctx = await conv.context(BACKGROUND_CONTEXT);
    return ctx.entries.slice(-maxEntries).map((e) => {
      const m = e.model?.[0];
      if (!m) return { id: e.id, kind: e.kind };
      if (m.role === "user") {
        if (typeof m.content === "string") return { id: e.id, role: "user", text: m.content };
        const blocks = m.content || [];
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        // History carries content-addressed ids only, never the base64 payload.
        const images = blocks.filter((b) => b.type === "image").map((b) => imageId(Buffer.from(String(b.data || ""), "base64")));
        return { id: e.id, role: "user", text, ...(images.length ? { images } : {}) };
      }
      if (m.role === "assistant") {
        const texts = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
        const thinking = extractAssistantThinking(m);
        const calls = extractAssistantToolCalls(m);
        return {
          id: e.id,
          role: "assistant",
          text: texts,
          ...(thinking ? { thinking } : {}),
          toolCalls: calls,
          ...(m.stopReason ? { stopReason: m.stopReason } : {}),
          ...(m.errorMessage ? { errorMessage: m.errorMessage } : {}),
        };
      }
      if (m.role === "toolResult") {
        const text = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
        return { id: e.id, role: "toolResult", toolName: m.toolName, isError: !!m.isError, text: text.slice(0, 4000) };
      }
      return { id: e.id, kind: e.kind };
    });
  }

  async function resolveOrchestrationModel(modelInput) {
    if (!modelInput) return roleModels.lead;
    const chosen = resolveLeadModelChoice(modelInput.provider, modelInput.modelId);
    if (!chosen || !models.getModel(chosen.provider, chosen.modelId)) {
      throw new Error(`Unknown model ${modelInput.provider}/${modelInput.modelId}`);
    }
    return chosen;
  }

  async function createNamedOrchestration(input) {
    const args = validateOrchestrationInput(input, workspaceDir);
    const chosenModel = await resolveOrchestrationModel(args.model);
    const swarm = await harnessRef.snapshot(SwarmDoc, BACKGROUND_CONTEXT);
    if (Object.keys(swarm?.orchestrations || {}).length >= 50) throw new Error("Orchestration limit reached (50)");
    if (args.cwd && args.cwd.startsWith(workspaceDir)) {
      await mkdir(args.cwd, { recursive: true });
    }
    const id = `orch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    let convId;
    await harnessRef.commit(async (tx) => {
      const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
      convId = c.id;
      await configure(tx, convId, {
        model: chosenModel,
        thinkingLevel: "max",
        cwd: args.cwd || workspaceDir,
        maxTurns: 20,
        tools: roleToolSet("orchestrator", args.preset),
        instructions: buildOrchestrationInstructions({ id, ...args, cwd: args.cwd || workspaceDir }),
      });
      const meta = await tx.doc(RoleMetaDoc, convId);
      Object.assign(meta, {
        role: "orchestrator",
        workerId: id,
        orchestrationId: id,
        preset: args.preset,
        cwd: args.cwd || workspaceDir,
        requireVerified: false,
      });
      const doc = await tx.doc(SwarmDoc);
      doc.orchestrations ||= {};
      doc.orchestrations[id] = {
        id,
        name: args.name,
        convId,
        createdAt: now,
        preset: args.preset,
        group: args.group,
        cwd: args.cwd || workspaceDir,
        repoUrl: args.repoUrl,
        instructions: args.instructions,
        ...(args.model ? { model: chosenModel } : {}),
      };
    }, BACKGROUND_CONTEXT);
    return {
      id,
      name: args.name,
      conversationId: convId,
      preset: args.preset,
      group: args.group,
      cwd: args.cwd || workspaceDir,
      repoUrl: args.repoUrl,
      instructions: args.instructions,
      ...(args.model ? { model: chosenModel } : {}),
    };
  }

  async function updateNamedOrchestration(id, patch) {
    if (!id || id === DEFAULT_ORCHESTRATION_ID) throw new Error("Cannot edit default general orchestration");
    const swarm = await harnessRef.snapshot(SwarmDoc, BACKGROUND_CONTEXT);
    const existing = swarm?.orchestrations?.[id];
    if (!existing) throw new Error(`Unknown orchestration: ${id}`);
    const merged = {
      name: patch?.name ?? existing.name,
      preset: patch?.preset ?? existing.preset ?? "custom",
      group: patch?.group ?? existing.group,
      cwd: patch?.cwd !== undefined ? patch.cwd : (existing.cwd || ""),
      repoUrl: patch?.repoUrl !== undefined ? patch.repoUrl : (existing.repoUrl || ""),
      instructions: patch?.instructions !== undefined ? patch.instructions : (existing.instructions || ""),
      provider: patch?.provider !== undefined ? patch.provider : existing.model?.provider,
      modelId: patch?.modelId !== undefined ? patch.modelId : existing.model?.modelId,
    };
    const args = validateOrchestrationInput(merged, workspaceDir);
    const chosenModel = await resolveOrchestrationModel(args.model);
    if (args.cwd && args.cwd.startsWith(workspaceDir)) {
      await mkdir(args.cwd, { recursive: true });
    }
    await harnessRef.commit(async (tx) => {
      await configure(tx, existing.convId, {
        model: chosenModel,
        thinkingLevel: "max",
        cwd: args.cwd || workspaceDir,
        maxTurns: 20,
        tools: roleToolSet("orchestrator", args.preset),
        instructions: buildOrchestrationInstructions({ id, ...args, cwd: args.cwd || workspaceDir }),
      });
      const meta = await tx.doc(RoleMetaDoc, existing.convId);
      Object.assign(meta, {
        role: "orchestrator",
        workerId: id,
        orchestrationId: id,
        preset: args.preset,
        cwd: args.cwd || workspaceDir,
        requireVerified: false,
      });
      const doc = await tx.doc(SwarmDoc);
      const nextOrch = {
        ...doc.orchestrations[id],
        name: args.name,
        preset: args.preset,
        group: args.group,
        cwd: args.cwd || workspaceDir,
        repoUrl: args.repoUrl,
        instructions: args.instructions,
      };
      if (args.model) nextOrch.model = chosenModel;
      else delete nextOrch.model;
      doc.orchestrations[id] = nextOrch;
    }, BACKGROUND_CONTEXT);
    return {
      ok: true,
      id,
      name: args.name,
      conversationId: existing.convId,
      preset: args.preset,
      group: args.group,
      cwd: args.cwd || workspaceDir,
      repoUrl: args.repoUrl,
      instructions: args.instructions,
    };
  }

  async function createPersistentWorker(orchestrationId, input) {
    const args = validateWorkerInput(input);
    let targetCwd = workspaceDir;
    if (orchestrationId !== DEFAULT_ORCHESTRATION_ID) {
      const snap = await harnessRef.snapshot(SwarmDoc, BACKGROUND_CONTEXT);
      const orch = snap?.orchestrations?.[orchestrationId];
      if (!orch) throw new Error(`Unknown orchestration: ${orchestrationId}`);
      if (orch.cwd) targetCwd = orch.cwd;
    }
    const workers = await listWorkersSnapshot();
    if (workers.filter((w) => w.orchestrationId === orchestrationId).length >= 25) throw new Error("Worker limit reached (25 per orchestration)");
    const workerId = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const mRef = roleModels[args.role] || roleModels.coder;
    const requireVerified = args.role === "coder";
    const now = Date.now();
    let convId;
    let taskId = null;
    await harnessRef.commit(async (tx) => {
      const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
      convId = c.id;
      await configure(tx, convId, {
        model: mRef,
        thinkingLevel: args.mode === "recurring" ? (ROLE_THINKING.watcher || "low") : (ROLE_THINKING[args.role] || "low"),
        cwd: targetCwd,
        maxTurns: args.role === "coder" ? 40 : 16,
        tools: roleToolSet(args.role),
        instructions: ROLE_INSTRUCTIONS[args.role] || ROLE_INSTRUCTIONS.coder,
      });
      const meta = await tx.doc(RoleMetaDoc, convId);
      Object.assign(meta, { role: args.role, workerId, orchestrationId, cwd: targetCwd, requireVerified });
      if (args.mode === "recurring") {
        taskId = await tx.createTask(ForeverWorkTask, { workerId }, {
          ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true,
        });
      }
      const doc = await tx.doc(SwarmDoc);
      doc.workers[workerId] = {
        workerId, orchestrationId, name: args.name, role: args.role, modelId: mRef.modelId,
        convId, requireVerified, goal: args.goal, mode: args.mode, everyMs: args.everyMs,
        enabled: true, runCount: 0, taskId, createdAt: now,
        supervisor: { status: "supervising", autoResumes: 0, nextAt: 0 },
      };
    }, BACKGROUND_CONTEXT);
    const conv = await harnessRef.conversation(convId, BACKGROUND_CONTEXT);
    if (args.mode === "once") {
      await conv.submit({ type: "input", content: `[ONE-SHOT | ORCHESTRATION=${orchestrationId} | WORKER=${workerId}]\n${args.goal}` }, BACKGROUND_CONTEXT);
    }
    harnessRef.resume();
    return { id: workerId, orchestrationId, conversationId: convId, taskId, ...args };
  }

  async function triggerPersistentWorker(workerId) {
    const snap = await harnessRef.snapshot(SwarmDoc, BACKGROUND_CONTEXT);
    const worker = snap?.workers?.[workerId];
    if (!worker?.orchestrationId || worker.enabled === false) throw new Error("Worker is unknown or paused");
    const live = await harnessRef.snapshot(LiveDoc, worker.convId, BACKGROUND_CONTEXT);
    if (live?.run) throw new Error("Worker is already running");
    const conv = await harnessRef.conversation(worker.convId, BACKGROUND_CONTEXT);
    await harnessRef.commit(async (tx) => {
      const doc = await tx.doc(SwarmDoc);
      const w = doc.workers[workerId];
      Object.assign(w, { lastRunAt: Date.now(), lastAction: "manual", runCount: (w.runCount || 0) + 1 });
    }, BACKGROUND_CONTEXT);
    await conv.submit({ type: "input", content: `[MANUAL RUN | ORCHESTRATION=${worker.orchestrationId} | WORKER=${workerId}]\n${worker.goal}` }, BACKGROUND_CONTEXT);
    harnessRef.resume();
    return { ok: true, workerId, conversationId: worker.convId };
  }

  const spawnWorkerTool = defineTool({
    name: "spawn_worker",
    description:
      "Spawn an isolated parallel background subagent conversation (`coder`, `reviewer`, `planner`, `support`, `social`, `watcher`). Returns immediately without blocking chat.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        workerId: { type: "string", description: "Unique short ID, e.g. 'w-auth' or 'rev-auth'" },
        role: { type: "string", enum: ["coder", "reviewer", "planner", "support", "social", "watcher"] },
        brief: { type: "string", description: "Complete task instructions, target files, and bus coordination topics." },
        requireVerified: { type: "boolean", description: "Require `Verified: PASS` before worker can finish (default true for coder)." },
      },
      required: ["workerId", "role", "brief"],
    },
    async execute(args, api, context) {
      const role = args.role;
      const mRef = roleModels[role] || roleModels.coder;
      const requireVerified = args.requireVerified ?? role === "coder";
      const parentMeta = await api.snapshot(RoleMetaDoc, api.conversationId, context);
      const orchestrationId = parentMeta?.orchestrationId || DEFAULT_ORCHESTRATION_ID;
      const targetCwd = parentMeta?.cwd || workspaceDir;
      let convId;
      await api.commit(async (tx) => {
        const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
        convId = c.id;
        await configure(tx, convId, {
          model: mRef,
          thinkingLevel: ROLE_THINKING[role] || "low",
          cwd: targetCwd,
          maxTurns: role === "coder" ? 40 : 16,
          tools: roleToolSet(role),
          instructions: ROLE_INSTRUCTIONS[role] || ROLE_INSTRUCTIONS.coder,
        });
        const rDoc = await tx.doc(RoleMetaDoc, convId);
        rDoc.role = role;
        rDoc.workerId = args.workerId;
        rDoc.orchestrationId = orchestrationId;
        rDoc.cwd = targetCwd;
        rDoc.requireVerified = requireVerified;

        const sDoc = await tx.doc(SwarmDoc);
        sDoc.workers[args.workerId] = {
          workerId: args.workerId,
          orchestrationId,
          name: args.workerId,
          mode: "once",
          role,
          modelId: mRef.modelId,
          convId,
          requireVerified,
          goal: args.brief, // original goal survives every auto-resume
          createdAt: Date.now(),
          supervisor: { status: "supervising", autoResumes: 0, nextAt: 0 },
        };
      }, context);

      const handle = await api.conversation(convId, context);
      await handle.submit(
        {
          type: "input",
          content: `[WORKER_ID=${args.workerId} | ROLE=${role} | WORKSPACE=${targetCwd}]\n${args.brief}`,
        },
        context,
      );
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify({ spawned: true, workerId: args.workerId, role, modelId: mRef.modelId, conversationId: convId }),
          },
        ],
      };
    },
  });

  const requestReviewTool = defineTool({
    name: "request_review",
    description: "Spawn the dedicated Security Reviewer (`GLM-5.3` / `DeepSeek V4 Pro`) on files you finished.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        fromWorkerId: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        deep: { type: "boolean", description: "Use DeepSeek V4 Pro instead of GLM-5.3 for deep audit." },
      },
      required: ["fromWorkerId", "files"],
    },
    async execute(args, api, context) {
      const reviewerId = `rev-${args.fromWorkerId}-${Date.now().toString(36).slice(-4)}`;
      const mRef = args.deep ? roleModels.reviewerDeep : roleModels.reviewer;
      let convId;
      await api.commit(async (tx) => {
        const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
        convId = c.id;
        await configure(tx, convId, {
          model: mRef,
          thinkingLevel: "max",
          cwd: workspaceDir,
          maxTurns: 8,
          tools: roleToolSet("reviewer"),
          instructions: ROLE_INSTRUCTIONS.reviewer,
        });
        const rDoc = await tx.doc(RoleMetaDoc, convId);
        rDoc.role = "reviewer";
        rDoc.workerId = reviewerId;
        rDoc.requireVerified = false;
        const sDoc = await tx.doc(SwarmDoc);
        sDoc.workers[reviewerId] = { workerId: reviewerId, role: "reviewer", modelId: mRef.modelId, convId, createdAt: Date.now() };
      }, context);

      const handle = await api.conversation(convId, context);
      await handle.submit(
        {
          type: "input",
          content: `Audit files ${args.files.join(", ")} for worker ${args.fromWorkerId}. Post verdict to \`${args.fromWorkerId}\` via \`bus_send\` under topic \`review\` and end with VERDICT: APPROVE or VERDICT: REQUEST_CHANGES.`,
        },
        context,
      );
      return { output: [{ type: "text", text: JSON.stringify({ reviewerId, conversationId: convId, modelId: mRef.modelId }) }] };
    },
  });

  const readSiblingTool = defineTool({
    name: "read_sibling",
    description: "Read full non-summarized messages and tool outputs of another session/worker by workerId or conversationId.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        workerId: { type: "string" },
        conversationId: { type: "number" },
        maxEntries: { type: "number" },
      },
    },
    async execute(args, api, context) {
      let targetId = args.conversationId;
      if (!targetId && args.workerId) {
        const s = (await api.snapshot(SwarmDoc, context)) ?? { workers: {} };
        targetId = args.workerId === "lead" ? ROOT_CONVERSATION_ID : s.workers?.[args.workerId]?.convId;
      }
      if (!targetId) {
        return { isError: true, output: [{ type: "text", text: `Unknown sibling worker: ${args.workerId || args.conversationId}` }] };
      }
      const [transcript, usageSnap, liveSnap] = await Promise.all([
        readConversationTranscript(targetId, args.maxEntries || 30),
        api.snapshot(UsageDoc, targetId, context),
        api.snapshot(LiveDoc, targetId, context),
      ]);
      const state = liveSnap?.run ? "running" : liveSnap?.runFailure ? `failed:${liveSnap.runFailure.reason}` : "idle_done";
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify({ conversationId: targetId, state, runFailure: liveSnap?.runFailure ?? null, usage: usageSnap ?? null, entries: transcript }),
          },
        ],
      };
    },
  });

  const listWorkersTool = defineTool({
    name: "list_workers",
    description: "List all workers with live run state (`running` / `idle_done` / `failed:turn_limit`), exact per-worker token/cost telemetry, cron jobs, and alerts.",
    replay: "safe",
    parameters: { type: "object", properties: {} },
    async execute(_args, api, context) {
      const s = (await api.snapshot(SwarmDoc, context)) ?? { workers: {}, cronJobs: {}, alerts: [], approvals: [] };
      const enrichedWorkers = {};
      for (const [wid, w] of Object.entries(s.workers || {})) {
        const [uSnap, lSnap] = await Promise.all([
          api.snapshot(UsageDoc, w.convId, context),
          api.snapshot(LiveDoc, w.convId, context),
        ]);
        let tokens = 0;
        let costUsd = 0;
        for (const m of Object.values(uSnap?.models || {})) {
          tokens += m.totalTokens ?? 0;
          costUsd += m.cost?.total ?? 0;
        }
        enrichedWorkers[wid] = {
          ...w,
          liveState: lSnap?.run ? "running" : lSnap?.runFailure ? `stopped:${lSnap.runFailure.reason}` : "done",
          turnsUsed: lSnap?.run?.turns ?? null,
          runFailure: lSnap?.runFailure ?? null,
          usage: { totalTokens: tokens, costUsd: +costUsd.toFixed(5), models: uSnap?.models ?? {} },
        };
      }
      const leadUsage = await api.snapshot(UsageDoc, ROOT_CONVERSATION_ID, context);
      return { output: [{ type: "text", text: JSON.stringify({ ...s, workers: enrichedWorkers, leadUsage }) }] };
    },
  });

  const busSendTool = defineTool({
    name: "bus_send",
    description: "Send a message on the shared SQLite AgentBus (`to: '*'` broadcasts to all agents).",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        topic: { type: "string" },
        body: { type: "string" },
        replyTo: { type: "number" },
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
    description: "Read or FTS5-search messages on the shared SQLite AgentBus.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        unreadOnly: { type: "boolean" },
        ackRead: { type: "boolean" },
        searchQuery: { type: "string" },
      },
      required: ["agentId"],
    },
    async execute(args) {
      const rows = args.searchQuery
        ? bus.search(args.searchQuery)
        : bus.inbox(args.agentId, { unreadOnly: args.unreadOnly ?? false });
      if (args.ackRead && !args.searchQuery) {
        for (const r of rows) bus.ack(args.agentId, r.id);
      }
      return { output: [{ type: "text", text: JSON.stringify(rows) }] };
    },
  });

  const saveDraftTool = defineTool({
    name: "save_draft",
    description:
      "Save or update a human-approval draft (`support` enforces strictly 1 open ticket/draft per humanKey; never sends externally).",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["support", "social", "incident"] },
        humanKey: { type: "string", description: "Customer email/handle or post slug (deduplicated 1-per-human for support)." },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["channel", "humanKey", "body"],
    },
    async execute(args, api, context) {
      const key = `${args.channel}:${args.humanKey.trim().toLowerCase()}`;
      let saved;
      await api.commit(async (tx) => {
        const sDoc = await tx.doc(SwarmDoc);
        const prev = sDoc.drafts[key];
        saved = {
          key,
          channel: args.channel,
          humanKey: args.humanKey.trim().toLowerCase(),
          subject: args.subject || prev?.subject || "",
          body: args.body,
          status: "draft_pending_human",
          revisions: (prev?.revisions || 0) + 1,
          updatedAt: Date.now(),
        };
        sDoc.drafts[key] = saved;
      }, context);
      bus.send({ from: args.channel, to: "lead", topic: "DRAFT_READY", body: `${key} (rev ${saved.revisions})` });
      return { output: [{ type: "text", text: JSON.stringify(saved) }] };
    },
  });

  const listDraftsTool = defineTool({
    name: "list_drafts",
    description: "List pending support/social/incident drafts awaiting human review.",
    replay: "safe",
    parameters: { type: "object", properties: {} },
    async execute(_args, api, context) {
      const s = (await api.snapshot(SwarmDoc, context)) ?? { drafts: {} };
      return { output: [{ type: "text", text: JSON.stringify(Object.values(s.drafts)) }] };
    },
  });

  const memoryWakeTool = defineTool({
    name: "memory_wake",
    description: "Read permanent cross-session OptMem binary summary tree (`memo wake`). Lead only.",
    replay: "safe",
    parameters: { type: "object", properties: {} },
    async execute() {
      const out = await optmem.wake();
      return { output: [{ type: "text", text: out }] };
    },
  });

  const memoryNoteTool = defineTool({
    name: "memory_note",
    description: "Record one permanent cross-session memory (`<=275` chars) and auto-drain OptMem `nap` merges. Lead only.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    },
    async execute(args) {
      const res = await optmem.note(args.note);
      return { output: [{ type: "text", text: JSON.stringify(res) }] };
    },
  });

  const memoryRecallTool = defineTool({
    name: "memory_recall",
    description: "Regex search across every raw memory ever recorded in OptMem (`memo recall`).",
    replay: "safe",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
    async execute(args) {
      const out = await optmem.recall(args.pattern);
      return { output: [{ type: "text", text: out || "(no matches)" }] };
    },
  });

  const listAgentsTool = defineTool({
    name: "list_agents",
    description: "List all durable Agent-Orchestrators (General, repo owners, marketers, security reviewers) with id, name, group, preset, cwd, and state.",
    replay: "safe",
    parameters: { type: "object", properties: {} },
    async execute() {
      const agents = await listOrchestrationsSnapshot();
      return { output: [{ type: "text", text: JSON.stringify(agents) }] };
    },
  });

  const askAgentTool = defineTool({
    name: "ask_agent",
    description: "Delegate a task or question to another Agent-Orchestrator by id or name (e.g. 'security-review-agent', 'linkedin-marketer', 'nuri-website', 'general'). Queues non-blocking into its durable conversation and logs on AgentBus.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target agent orchestration id or name (case-insensitive)." },
        brief: { type: "string", description: "Concrete request, file paths, or context for the target agent." },
      },
      required: ["target", "brief"],
    },
    async execute(args, api, context) {
      const callerMeta = await api.snapshot(RoleMetaDoc, api.conversationId, context);
      const fromId = callerMeta?.workerId || "lead";
      const needle = String(args.target || "").trim().toLowerCase();
      const all = await listOrchestrationsSnapshot();
      const target = all.find((a) => a.id.toLowerCase() === needle || a.name.toLowerCase() === needle);
      if (!target) {
        return { output: [{ type: "text", text: JSON.stringify({ delegated: false, error: `Unknown agent: ${args.target}` }) }] };
      }
      if (target.conversationId === api.conversationId) {
        return { output: [{ type: "text", text: JSON.stringify({ delegated: false, error: "Cannot delegate to self" }) }] };
      }
      const body = String(args.brief || "").trim();
      bus.send({ from: fromId, to: target.id, topic: "AGENT_DELEGATE", body });
      const conv = await harnessRef.conversation(target.conversationId, BACKGROUND_CONTEXT);
      await conv.submit(
        {
          type: "input",
          content: `[DELEGATED FROM ${fromId}]\n${body}\n\n(Reply via \`bus_send\` to \`${fromId}\` when finished.)`,
        },
        BACKGROUND_CONTEXT,
      );
      harnessRef.resume();
      return {
        output: [{ type: "text", text: JSON.stringify({ delegated: true, targetId: target.id, targetName: target.name, conversationId: target.conversationId }) }],
      };
    },
  });

  const scheduleForeverTool = defineTool({
    name: "schedule_forever_agent",
    description: "Start a durable `sleepUntil` forever-agent (`logs`, `support`, `social`) gated by System-1 Jev triage.",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        kind: { type: "string", enum: ["logs", "support", "social"] },
        sourcePath: { type: "string", description: "Optional log/inbox file path to tail incrementally." },
        everyMs: { type: "number", description: "Poll interval in ms (min 250)." },
      },
      required: ["jobId", "kind", "everyMs"],
    },
    async execute(args, api, context) {
      let taskId;
      await api.commit(async (tx) => {
        taskId = await tx.createTask(
          ForeverWatchTask,
          { jobId: args.jobId, kind: args.kind, sourcePath: args.sourcePath || "", everyMs: args.everyMs },
          { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true },
        );
        const sDoc = await tx.doc(SwarmDoc);
        sDoc.cronJobs[args.jobId] = {
          jobId: args.jobId,
          kind: args.kind,
          sourcePath: args.sourcePath || "",
          everyMs: args.everyMs,
          taskId,
          createdAt: Date.now(),
        };
      }, context);
      return { output: [{ type: "text", text: JSON.stringify({ scheduled: true, jobId: args.jobId, taskId }) }] };
    },
  });

  // Durable auto-continue supervisor: bounded turn_limit recovery + lead notifications
  const supervisor = createSupervisor({
    opts: supervisorOpts,
    workers: async () => {
      const s = (await harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT)) ?? { workers: {} };
      return s.workers || {};
    },
    live: (convId) => harness.snapshot(LiveDoc, convId, BACKGROUND_CONTEXT),
    patch: async (workerId, mutate) => {
      await harness.commit(async (tx) => {
        const s = await tx.doc(SwarmDoc);
        const w = s.workers[workerId];
        if (w) mutate(w);
      }, BACKGROUND_CONTEXT);
    },
    transcript: readConversationTranscript,
    resumeWorker: async (worker, { notice, summary }) => {
      const conv = await harness.conversation(worker.convId, BACKGROUND_CONTEXT);
      // Never resume over a live run: the scheduler would queue a second input behind it.
      const liveNow = await harness.snapshot(LiveDoc, worker.convId, BACKGROUND_CONTEXT);
      if (!conv || liveNow?.run) return false;
      // A run that keeps asking for more tests must not be starved by its own maxTurns.
      const grown = (worker.maxTurns || 40) + 20;
      await conv.commit(async (tx) => {
        const agent = await tx.doc(RoleMetaDoc, conv.id);
        agent.role = agent.role || worker.role;
        await configure(tx, conv.id, { maxTurns: grown });
        const s = await tx.doc(SwarmDoc);
        const w = s.workers[worker.workerId];
        if (w) w.maxTurns = grown;
      }, BACKGROUND_CONTEXT);
      const ctx = summary?.commit || summary?.tests?.length
        ? `${notice}\n\nAlready reached (authoritative, do not redo): ${summary.commit ? `commit ${summary.commit}; ` : ""}${summary.tests.join(" | ") || "no test output"}.`
        : notice;
      await conv.submit({ type: "input", content: ctx }, BACKGROUND_CONTEXT);
      harness.resume();
      return true;
    },
    notifyLead: async (topic, body) => {
      bus.send({ from: "supervisor", to: "lead", topic, body });
      // Wake idle lead only; a busy lead gets the bus message and is never interrupted.
      const live = await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
      if (live?.run) return;
      await lead.submit({ type: "input", content: `[BUS ${topic}]\n${body}` }, BACKGROUND_CONTEXT);
      harness.resume();
    },
  });

  // Out-of-Core Guardrail & Lifecycle Hook Registry (`src/hooks.mjs`)
  const hookRegistry = new HookRegistry(
    createBuiltinGuardHooks({
      onYieldHardTestGate: async (answer, { meta, api }) => {
        if (!meta?.requireVerified) return;
        const txt = extractAssistantText(answer);
        const prevRetries = yieldRetries.get(api.conversationId) || 0;
        const passed = /Verified:\s*PASS/i.test(txt);
        if (!passed && prevRetries < 1) {
          yieldRetries.set(api.conversationId, prevRetries + 1);
          return {
            continue:
              "VERIFICATION GATE: Run ALL syntax checks (`for f in src/*.mjs; do node --check \"$f\"; done`) AND ALL unit test files (`test/*.test.mjs` except `test/swarm.test.mjs`) via `bash`, fix any failing assertion, and end with `Verified: PASS (<test command>)`.",
          };
        }
        if (passed && meta.role === "coder") {
          const gateKey = `hardtest:${api.conversationId}`;
          const prevHard = yieldRetries.get(gateKey) || 0;
          if (prevHard < 2) {
            try {
              await execFileAsync(
                "bash",
                [
                  "-lc",
                  'shopt -s nullglob; ran=0; srcs=0; ' +
                    'for f in src/*.mjs src/*.js src/*.cjs *.mjs *.js *.cjs; do [ -f "$f" ] || continue; srcs=$((srcs+1)); node --no-warnings --check "$f" || exit 1; done; ' +
                    'for t in test/*.test.mjs test/*.test.js test/*.test.cjs src/*.test.mjs src/*.test.js src/*.test.cjs *.test.mjs *.test.js *.test.cjs; do ' +
                    '[ "$t" = "test/swarm.test.mjs" ] && continue; ran=$((ran+1)); node --no-warnings --test "$t" || exit 1; done; ' +
                    'if [ "$ran" -eq 0 ]; then ' +
                    'if [ -f go.mod ]; then go test ./... || exit 1; ran=1; ' +
                    'elif [ -f pyproject.toml ] || [ -f pytest.ini ]; then pytest -q || exit 1; ran=1; fi; fi; ' +
                    'if [ "$ran" -eq 0 ] && [ "$srcs" -gt 0 ]; then echo "HARD GATE: zero test files found/executed for $srcs source file(s)" >&2; exit 1; fi',
                ],
                { cwd: meta?.cwd || workspaceDir, timeout: 45_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
              );
              yieldRetries.delete(gateKey);
              yieldRetries.delete(api.conversationId);
            } catch (err) {
              yieldRetries.set(gateKey, prevHard + 1);
              const out = `${err?.stdout || ""}\n${err?.stderr || err?.message || err}`.trim().slice(-1200);
              return {
                continue: `HARD TEST GATE FAILED — you claimed \`Verified: PASS\`, but automated syntax/unit tests failed in \`${meta?.cwd || workspaceDir}\`. Fix every failure and re-verify before finishing:\n${out}`,
              };
            }
          }
        }
      },
      onYieldAutoBackupGate: async (_answer, { meta, api }) => {
        if (meta?.role !== "lead" || !existsSync(join(SELF_REPO_DIR, ".git"))) return;
        try {
          const { stdout } = await execFileAsync("git", ["-C", SELF_REPO_DIR, "status", "--porcelain"], {
            timeout: 5000,
          });
          if (stdout.trim()) {
            const syncKey = `git:${api.conversationId}`;
            const prevSync = yieldRetries.get(syncKey) || 0;
            if (prevSync < 2) {
              yieldRetries.set(syncKey, prevSync + 1);
              try {
                await execFileAsync(
                  "sudo",
                  ["/usr/local/bin/swarm-ctl", "apply", `auto(${meta.workerId || meta.role}): verified self-update`],
                  { timeout: 45_000 },
                );
              } catch (err) {
                const msg = String(err?.stderr || err?.stdout || err?.message || err).slice(0, 600);
                return {
                  continue: `AUTO-BACKUP GATE FAILED (\`swarm-ctl apply\`): fix syntax/test error before finishing:\n${msg}`,
                };
              }
            }
          }
        } catch {}
      },
    }),
  );
  for (const h of customHooks) hookRegistry.register(h);

  const swarmExtension = defineExtension({
    name: "swarm-core",
    tasks: [ForeverWatchTask, ForeverWorkTask],
    tools: [
      spawnWorkerTool,
      requestReviewTool,
      readSiblingTool,
      listWorkersTool,
      listAgentsTool,
      askAgentTool,
      busSendTool,
      busInboxTool,
      saveDraftTool,
      listDraftsTool,
      memoryWakeTool,
      memoryNoteTool,
      memoryRecallTool,
      scheduleForeverTool,
    ],
    hooks: [
      hook(ToolTask, {
        async beforeTool(call, api, context) {
          const meta = (await api.snapshot(RoleMetaDoc, api.conversationId, context)) ?? {
            role: "lead",
            workerId: "lead",
            requireVerified: false,
          };
          const res = await hookRegistry.runBeforeTool(call, { meta, api, context, workspaceDir });
          if (res?.block) return { block: res.block };
          if (res?.arguments) return { arguments: res.arguments };
        },
        async afterTool(call, result, api, context) {
          const meta = (await api.snapshot(RoleMetaDoc, api.conversationId, context)) ?? {
            role: "lead",
            workerId: "lead",
            requireVerified: false,
          };
          return hookRegistry.runAfterTool(call, result, { meta, api, context, workspaceDir });
        },
      }),
      hook(GenerationTask, {
        async onYield(answer, api, context) {
          const meta = (await api.snapshot(RoleMetaDoc, api.conversationId, context)) ?? {
            role: "lead",
            requireVerified: false,
          };
          const res = await hookRegistry.runOnYield(answer, { meta, api, context, workspaceDir });
          if (res?.continue) return { continue: res.continue };
        },
      }),
    ],
  });

  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(swarmExtension);

  const storage = await openNodeSqliteStorage(dbPath);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: {
        toolExecution: "parallel",
        retry: retryOverride,
        stream: { timeoutMs: streamTimeoutMs },
      },
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd || workspaceDir, shellEnv: { NODE_TEST_CONTEXT: undefined } }),
    },
    BACKGROUND_CONTEXT,
  );
  harnessRef = harness;

  // Ensure Root Lead conversation is configured with Lead profile + V3 Caveman/ADHD instructions
  const lead = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: roleModels.lead,
      thinkingLevel: "max",
      cwd: workspaceDir,
      maxTurns: 16,
      tools: roleToolSet("lead"),
      instructions: ROLE_INSTRUCTIONS.lead,
    },
  });
  await lead.commit(async (tx) => {
    await configure(tx, lead.id, {
      model: roleModels.lead,
      thinkingLevel: "max",
      cwd: workspaceDir,
      maxTurns: 16,
      tools: roleToolSet("lead"),
      instructions: ROLE_INSTRUCTIONS.lead,
    });
    const rDoc = await tx.doc(RoleMetaDoc, lead.id);
    rDoc.role = "lead";
    rDoc.workerId = "lead";
    rDoc.orchestrationId = DEFAULT_ORCHESTRATION_ID;
    rDoc.requireVerified = false;
    // Re-apply a durable dropdown override so it survives daemon restarts.
    const sDoc = await tx.doc(SwarmDoc);
    const ov = sDoc.leadModelOverride;
    const chosen = ov ? resolveLeadModelChoice(ov.provider, ov.modelId) : null;
    if (chosen) await configure(tx, lead.id, { model: chosen });
  }, BACKGROUND_CONTEXT);

  // Create/reuse dedicated `/btw` read-only Side-Chat conversation
  let btwConv = null;
  async function getBtwConversation() {
    if (btwConv) return btwConv;
    const snap = (await harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT)) ?? { workers: {} };
    if (snap.workers?.["btw-sidechat"]?.convId) {
      btwConv = await harness.conversation(snap.workers["btw-sidechat"].convId, BACKGROUND_CONTEXT);
      if (btwConv) return btwConv;
    }
    btwConv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: roleModels.btw,
          thinkingLevel: "low",
          cwd: workspaceDir,
          maxTurns: 6,
          tools: roleToolSet("btw"),
          instructions: ROLE_INSTRUCTIONS.btw,
        },
      },
      BACKGROUND_CONTEXT,
    );
    await btwConv.commit(async (tx) => {
      const rDoc = await tx.doc(RoleMetaDoc, btwConv.id);
      rDoc.role = "btw";
      rDoc.workerId = "btw-sidechat";
      rDoc.requireVerified = false;
      const sDoc = await tx.doc(SwarmDoc);
      sDoc.workers["btw-sidechat"] = {
        workerId: "btw-sidechat",
        role: "btw",
        modelId: roleModels.btw.modelId,
        convId: btwConv.id,
        createdAt: Date.now(),
      };
    }, BACKGROUND_CONTEXT);
    return btwConv;
  }



  async function getStatusSnapshot() {
    const [swarm, inspection, usage, leadCtx, leadLive] = await Promise.all([
      harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT),
      harness.inspect(BACKGROUND_CONTEXT),
      harness.usage(BACKGROUND_CONTEXT),
      lead.context(BACKGROUND_CONTEXT).catch(() => null),
      harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT).catch(() => null),
    ]);
    let totalTokens = 0;
    let costUsd = 0;
    for (const u of Object.values(usage?.models || {})) {
      totalTokens += u.totalTokens ?? 0;
      costUsd += u.cost?.total ?? 0;
    }
    let activeProvider = roleModels.lead.provider;
    let activeModel = roleModels.lead.modelId;
    let contextTokens = 0;
    for (let i = (leadCtx?.entries?.length || 0) - 1; i >= 0; i--) {
      const m = leadCtx.entries[i]?.model?.[0];
      if (m?.role === "assistant") {
        if (m.provider) activeProvider = m.provider;
        if (m.model) activeModel = m.model;
        const u = m.usage;
        const ctxTok = (u?.input || 0) + (u?.cacheRead || 0) + (u?.cacheWrite || 0) + (u?.output || 0);
        if (ctxTok > 0) {
          contextTokens = ctxTok;
          break;
        }
      }
    }
    // Durable dropdown override wins: it is what the NEXT turn will run (globally, not per session).
    const override = resolveLeadModelChoice(swarm?.leadModelOverride?.provider, swarm?.leadModelOverride?.modelId);
    const lastUsed = { provider: activeProvider, model: activeModel };
    if (override) {
      activeProvider = override.provider;
      activeModel = override.modelId;
    }
    const modelSpec = models.getModel(activeProvider, activeModel) || models.getModel(roleModels.lead.provider, roleModels.lead.modelId);
    const contextWindow = modelSpec?.contextWindow || 1_048_576;
    return {
      swarm: swarm ?? { workers: {}, drafts: {}, alerts: [], cronJobs: {} },
      liveTasks: inspection.tasks.length,
      pendingSubmissions: inspection.submissions.length,
      lead: {
        provider: activeProvider,
        model: activeModel,
        overridden: Boolean(override),
        lastUsed: override ? lastUsed : null,
        contextTokens,
        contextWindow,
        busy: Boolean(leadLive?.run),
      },
      hooks: hookRegistry.list(),
      usage: { totalTokens, costUsd: +costUsd.toFixed(5), byModel: usage?.models ?? {} },
    };
  }

  async function listWorkersSnapshot() {
    const swarm = (await harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT)) ?? { workers: {} };
    const out = [];
    for (const w of Object.values(swarm.workers || {})) {
      if (!w) continue;
      const convId = w.convId ?? w.conversationId;
      const live = convId ? await harness.snapshot(LiveDoc, convId, BACKGROUND_CONTEXT) : null;
      const liveProgress = summarizeLiveProgress(live);
      out.push({ ...describeWorker(w, live), nextRunAt: nextRunAt(w), ...(liveProgress ? { live: liveProgress } : {}) });
    }
    return sortWorkers(out);
  }

  async function readLiveConversationSnapshot(convId) {
    if (!harnessRef) return null;
    const live = await harnessRef.snapshot(LiveDoc, convId, BACKGROUND_CONTEXT).catch(() => null);
    return summarizeLiveProgress(live);
  }

  async function listOrchestrationsSnapshot() {
    const snap = (await harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT)) || {};
    const all = [
      { id: DEFAULT_ORCHESTRATION_ID, name: "General", convId: ROOT_CONVERSATION_ID, createdAt: 0 },
      ...Object.values(snap.orchestrations || {}),
    ];
    const out = [];
    for (const o of all) {
      const live = await harness.snapshot(LiveDoc, o.convId, BACKGROUND_CONTEXT);
      out.push(publicOrchestration(o, live));
    }
    return out;
  }

  supervisor.start();

  return {
    harness,
    lead,
    bus,
    hooks: hookRegistry,
    supervisor,
    optmem,
    workspaceDir,
    dataDir,

    /**
     * Submit user message:
     * - Deterministic zero-LLM slash commands (`/help`, `/status`, `/workers`, `/hooks`, `/credits`)
     *   execute in <50ms with 0 LLM calls even if every cloud & local provider is down!
     * - `/btw ...` routes immediately to isolated read-only Side-Chat without touching Lead!
     * - `steer: true` (`Ctrl+S` live feedback) injects mid-run into Lead or named `targetWorkerId`!
     * - Multi-task prompt gets tagged via System-1 Jev so Lead fans out parallel background workers without blocking!
     */
    async chat(text, { steer = false, targetWorkerId = "lead", wait = true, images = [] } = {}) {
      const hasImages = Array.isArray(images) && images.length > 0;
      if (text == null || typeof text !== "string" || (!text.trim() && !hasImages)) {
        return {
          route: "invalid",
          conversationId: ROOT_CONVERSATION_ID,
          status: "rejected",
          text: "",
          error: "Empty or non-string message",
        };
      }
      const trimmed = text.trim();
      if (targetWorkerId === "lead" && !steer) {
        const cmdRes = await handleDeterministicCommand(trimmed, {
          getStatus: getStatusSnapshot,
          listWorkers: listWorkersSnapshot,
          listHooks: () => hookRegistry.list(),
          probeCredits,
          setLeadModel: (p2, m2) => setLeadModel(p2, m2),
          conversationId: ROOT_CONVERSATION_ID,
        });
        if (cmdRes) return cmdRes;
      }
      if (/^\/reinforce(?:\s|$)/i.test(trimmed) && targetWorkerId === "lead" && !steer) {
        const arg = trimmed.replace(/^\/reinforce\s*/i, "").trim().toLowerCase();
        const { runReinforceTournament, DEFAULT_CANDIDATES } = await import("./reinforce.mjs");
        const selected =
          arg === "quick"
            ? DEFAULT_CANDIDATES.slice(0, 2)
            : arg
              ? DEFAULT_CANDIDATES.filter((c) => c.id.includes(arg) || c.leadModel.includes(arg) || c.coderModel.includes(arg))
              : DEFAULT_CANDIDATES;
        const cands = selected.length ? selected : DEFAULT_CANDIDATES.slice(0, 2);
        const jobId = `reinforce-${Date.now().toString(36)}`;
        runReinforceTournament({
          repoDir: SELF_REPO_DIR,
          envFile: join(SELF_REPO_DIR, ".env"),
          optmemMirrorDir: memoryDir,
          candidates: cands,
        })
          .then((res) => {
            bus.send({
              from: "reinforce",
              to: "lead",
              topic: "REINFORCE_DONE",
              body: `[/reinforce ${jobId}] Winner: ${res.winner?.candidateId} (Judge ${res.winner?.judge?.meanScore}/100, Cost $${res.winner?.metrics?.costUsd}). Report written to docs/REINFORCE_BENCHMARK.md`,
            });
          })
          .catch((err) => {
            bus.send({
              from: "reinforce",
              to: "lead",
              topic: "REINFORCE_ERROR",
              body: `[/reinforce ${jobId}] Failed: ${err?.message || err}`,
            });
          });
        return {
          route: "reinforce",
          conversationId: ROOT_CONVERSATION_ID,
          status: "started",
          text: `Started isolated Docker \`/reinforce\` replay (\`${jobId}\`) across ${cands.length} open-weights candidate(s): ${cands.map((c) => `\`${c.id}\``).join(", ")}.\nJudges: \`claude-fable-5-2\` + \`gpt-6.2-astra\` (3 personas, blinded). Results will land in \`docs/REINFORCE_BENCHMARK.md\` and notify Lead via \`REINFORCE_DONE\`.`,
        };
      }
      const routeInfo = await classifyUserPrompt(text, triageOpts);
      if (routeInfo.route === "side_chat_readonly" && targetWorkerId === "lead" && !steer) {
        const side = await getBtwConversation();
        const sub = await side.submit(
          { type: "input", content: `[LIVE SIDE-CHAT /btw]\n${routeInfo.cleanPrompt}` },
          BACKGROUND_CONTEXT,
        );
        if (!wait) return { route: "btw", submissionId: sub.id, conversationId: side.id };
        const settled = await sub.wait(BACKGROUND_CONTEXT);
        const entry =
          settled.status === "done"
            ? await side.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT)
            : null;
        const errMsg = settled.status !== "done" ? settled.detail || settled.reason || settled.status : undefined;
        const thinking = extractAssistantThinking(entry);
        const toolCalls = extractAssistantToolCalls(entry);
        return {
          route: "btw",
          conversationId: side.id,
          status: settled.status,
          text: extractAssistantText(entry),
          ...(thinking ? { thinking } : {}),
          ...(toolCalls.length ? { toolCalls } : {}),
          ...(errMsg ? { error: errMsg } : {}),
        };
      }

      let targetConv = lead;
      const isOrchestrationTarget = targetWorkerId.startsWith("orchestration:");
      if (isOrchestrationTarget) {
        const id = targetWorkerId.slice("orchestration:".length);
        const snap = await harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT);
        const orchestration = snap?.orchestrations?.[id];
        if (!orchestration) throw new Error(`Unknown orchestration: ${id}`);
        targetConv = await harness.conversation(orchestration.convId, BACKGROUND_CONTEXT);
      } else if (targetWorkerId !== "lead") {
        const snap = (await harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT)) ?? { workers: {} };
        const w = snap.workers?.[targetWorkerId];
        if (!w) throw new Error(`Unknown targetWorkerId: ${targetWorkerId}`);
        targetConv = await harness.conversation(w.convId, BACKGROUND_CONTEXT);
      }

      const promptText =
        (targetWorkerId === "lead" || isOrchestrationTarget) && routeInfo.route === "fanout_parallel"
          ? `[ROUTER_HINT: fanout_parallel — spawn separate parallel workers via spawn_worker and return immediately]\n${text}`
          : text;
      // Real image content blocks: provider sees the actual bytes, not filenames.
      const validatedImages = hasImages
        ? images.map((i) => {
            const { buf, mimeType } = decodeImage({ data: String(i?.data || ""), mimeType: String(i?.mimeType || "") });
            return { type: "image", data: buf.toString("base64"), mimeType };
          })
        : [];
      const content = validatedImages.length
        ? [
            ...(promptText.trim() ? [{ type: "text", text: promptText }] : []),
            ...validatedImages,
          ]
        : promptText;

      const sub = await targetConv.submit(
        {
          type: "input",
          content,
          ...(steer ? { whenBusy: "steer" } : {}),
        },
        BACKGROUND_CONTEXT,
      );
      if (!wait) return { route: routeInfo.route, submissionId: sub.id, conversationId: targetConv.id };
      const settled = await sub.wait(BACKGROUND_CONTEXT);
      const entry =
        settled.status === "done"
          ? await targetConv.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT)
          : null;
      const errMsg = settled.status !== "done" ? settled.detail || settled.reason || settled.status : undefined;
      const thinking = extractAssistantThinking(entry);
      const toolCalls = extractAssistantToolCalls(entry);
      return {
        route: routeInfo.route,
        conversationId: targetConv.id,
        status: settled.status,
        text: extractAssistantText(entry),
        ...(thinking ? { thinking } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(errMsg ? { error: errMsg } : {}),
      };
    },

    createOrchestration: createNamedOrchestration,
    updateOrchestration: updateNamedOrchestration,
    listOrchestrations: listOrchestrationsSnapshot,
    createOrchestrationWorker: createPersistentWorker,

    async setOrchestrationWorkerEnabled(workerId, enabled) {
      const snap = await harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT);
      if (!snap?.workers?.[workerId]?.orchestrationId) throw new Error(`Unknown orchestration worker: ${workerId}`);
      if (snap.workers[workerId].mode !== "recurring") throw new Error("Only recurring workers can be paused");
      await harness.commit(async (tx) => {
        const doc = await tx.doc(SwarmDoc);
        Object.assign(doc.workers[workerId], { enabled: Boolean(enabled), lastAction: enabled ? "resumed" : "paused" });
      }, BACKGROUND_CONTEXT);
      return { ok: true, workerId, enabled: Boolean(enabled) };
    },

    triggerOrchestrationWorker: triggerPersistentWorker,

    async scheduleForever({ jobId, kind, sourcePath = "", everyMs = 60_000 }) {
      let taskId;
      await harness.commit(async (tx) => {
        taskId = await tx.createTask(
          ForeverWatchTask,
          { jobId, kind, sourcePath, everyMs },
          { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true },
        );
        const sDoc = await tx.doc(SwarmDoc);
        sDoc.cronJobs[jobId] = { jobId, kind, sourcePath, everyMs, taskId, createdAt: Date.now() };
      }, BACKGROUND_CONTEXT);
      harness.resume();
      return { jobId, taskId };
    },

    status: getStatusSnapshot,

    /**
     * Switch the Lead model (allowlisted pairs only, no arbitrary IDs/secrets).
     * Durable in SwarmDoc so it survives reloads/restarts; applies to NEW turns globally.
     * Refuses while Lead is busy (running turn keeps its model) and returns the stored pair.
     */
    async scheduleForever({ jobId, kind, sourcePath = "", everyMs = 60_000 }) {
      let taskId;
      await harness.commit(async (tx) => {
        taskId = await tx.createTask(
          ForeverWatchTask,
          { jobId, kind, sourcePath, everyMs },
          { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true },
        );
        const sDoc = await tx.doc(SwarmDoc);
        sDoc.cronJobs[jobId] = { jobId, kind, sourcePath, everyMs, taskId, createdAt: Date.now() };
      }, BACKGROUND_CONTEXT);
      harness.resume();
      return { jobId, taskId };
    },

    status: getStatusSnapshot,

    /**
     * Switch the Lead model (allowlisted pairs only, no arbitrary IDs/secrets).
     * Durable in SwarmDoc so it survives reloads/restarts; applies to NEW turns globally.
     * Refuses while Lead is busy (running turn keeps its model) and returns the stored pair.
     */
    async setLeadModel(provider, modelId) {
      const chosen = resolveLeadModelChoice(provider, modelId);
      if (!chosen) {
        return {
          error: `Unknown model \`${String(provider || "")}/${String(modelId || "")}\` (not in allowlist)`,
          statusCode: 400,
        };
      }
      if (!models.getModel(chosen.provider, chosen.modelId)) {
        return { error: `Model \`${chosen.provider}/${chosen.modelId}\` not registered`, statusCode: 400 };
      }
      const live = await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT).catch(() => null);
      const busy = Boolean(live?.run);
      await harness.commit(async (tx) => {
        const sDoc = await tx.doc(SwarmDoc);
        sDoc.leadModelOverride = { provider: chosen.provider, modelId: chosen.modelId, updatedAt: Date.now() };
        await configure(tx, lead.id, { model: chosen });
      }, BACKGROUND_CONTEXT);
      return {
        ok: true,
        busy,
        active: { provider: chosen.provider, modelId: chosen.modelId },
        warning: busy ? "Lead is busy: the running turn keeps its model, the next turn uses the new one." : undefined,
      };
    },

    /** Read-only sidebar list: authoritative swarm registry + live run state, running first. */
    listWorkers: listWorkersSnapshot,

    listHooks() {
      return hookRegistry.list();
    },

    async waitForWorker(workerId, timeoutMs = 120_000) {
      const snap = (await harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT)) ?? { workers: {} };
      const w = snap.workers?.[workerId];
      if (!w) throw new Error(`Unknown worker: ${workerId}`);
      const conv = await harness.conversation(w.convId, BACKGROUND_CONTEXT);
      let timer;
      try {
        await Promise.race([
          conv.waitForIdle(BACKGROUND_CONTEXT),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`Timeout waiting for ${workerId}`)), timeoutMs);
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        const transcript = await readConversationTranscript(w.convId, 30).catch(() => []);
        const failed = [...transcript].reverse().find((e) => e.role === "assistant" && e.stopReason === "error" && e.errorMessage);
        if (failed) throw new Error(`${error.message}: ${failed.errorMessage}`, { cause: error });
        throw error;
      } finally {
        clearTimeout(timer);
      }
      const transcript = await readConversationTranscript(w.convId, 30);
      const failed = [...transcript].reverse().find((e) => e.role === "assistant" && e.stopReason === "error" && e.errorMessage);
      if (failed) throw new Error(`Worker ${workerId} failed: ${failed.errorMessage}`);
      return transcript;
    },

    readTranscript: readConversationTranscript,
    readLiveConversation: readLiveConversationSnapshot,

    async close() {
      supervisor.stop();
      try {
        await harness.close(BACKGROUND_CONTEXT);
      } finally {
        bus.close();
      }
    },
  };
}
