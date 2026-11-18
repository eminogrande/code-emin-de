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
  ROOT_CONVERSATION_ID,
  ToolTask,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openAgentBus } from "./bus.mjs";
import { createOpenModels, ROLE_MODELS } from "./models.mjs";
import { createOptMem } from "./optmem.mjs";
import { ROLE_INSTRUCTIONS } from "./prompts.mjs";
import { classifyUserPrompt, triageWatcherEvent } from "./triage.mjs";

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
  }),
  checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 16,
});

export const RoleMetaDoc = defineDoc({
  kind: "swarm.role",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ role: "lead", workerId: "lead", requireVerified: false }),
  checkpointWhen: () => true,
});

const DESTRUCTIVE_BASH_RE =
  /\b(rm\s+-rf\s+\/(?:\s|$)|git\s+push\s+(?:--force|-f|--delete)\b|git\s+push\s+\S+\s+\+|git\s+reset\s+--hard|mkfs\.|dd\s+if=.*of=\/dev\/|curl\b.*\|\s*(?:ba)?sh|authorized_keys|sshd_config|00-nuri-smartcard|ufw\s+disable)\b/i;

const OUTBOUND_SEND_RE =
  /\b(sendmail|postfix|smtp|api\.resend\.com|api\.sendgrid\.com|api\.twitter\.com\/2\/tweets|x\.com\/i\/api)\b/i;

const READONLY_ROLES = new Set(["btw", "reviewer", "planner"]);

export function extractAssistantText(entryOrMsg) {
  const msg = entryOrMsg?.model?.[0] ?? entryOrMsg;
  if (!msg || !Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function roleToolSet(role) {
  return roleToolNames(role).map((name) => ({ name }));
}

function roleToolNames(role) {
  switch (role) {
    case "lead":
      return [
        "spawn_worker",
        "list_workers",
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

export async function openSwarmDaemon({
  dataDir,
  workspaceDir,
  models = createOpenModels(),
  roleModels = ROLE_MODELS,
  triageOpts = {},
} = {}) {
  if (!dataDir || !workspaceDir) throw new Error("openSwarmDaemon requires dataDir and workspaceDir");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const dbPath = join(dataDir, "durable.sqlite");
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
              doc.cronJobs[jobId] = { ...(doc.cronJobs[jobId] || {}), lastAction: "page_immediately", lastTickAt: now };
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
                thinkingLevel: "high",
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
              sDoc.cronJobs[jobId] = { ...(sDoc.cronJobs[jobId] || {}), lastAction: "draft_only", lastTickAt: now };
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
              sDoc.cronJobs[jobId] = { ...(sDoc.cronJobs[jobId] || {}), lastAction: "stay_silent", lastTickAt: now };
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
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return { id: e.id, role: "user", text };
      }
      if (m.role === "assistant") {
        const texts = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
        const calls = (m.content || []).filter((b) => b.type === "toolCall").map((b) => `${b.name}(${JSON.stringify(b.arguments)})`);
        return { id: e.id, role: "assistant", text: texts, toolCalls: calls };
      }
      if (m.role === "toolResult") {
        const text = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
        return { id: e.id, role: "toolResult", toolName: m.toolName, isError: !!m.isError, text: text.slice(0, 4000) };
      }
      return { id: e.id, kind: e.kind };
    });
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
      let convId;
      await api.commit(async (tx) => {
        const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
        convId = c.id;
        await configure(tx, convId, {
          model: mRef,
          thinkingLevel: "high",
          cwd: workspaceDir,
          maxTurns: role === "coder" ? 16 : 8,
          tools: roleToolSet(role),
          instructions: ROLE_INSTRUCTIONS[role] || ROLE_INSTRUCTIONS.coder,
        });
        const rDoc = await tx.doc(RoleMetaDoc, convId);
        rDoc.role = role;
        rDoc.workerId = args.workerId;
        rDoc.requireVerified = requireVerified;

        const sDoc = await tx.doc(SwarmDoc);
        sDoc.workers[args.workerId] = {
          workerId: args.workerId,
          role,
          modelId: mRef.modelId,
          convId,
          requireVerified,
          createdAt: Date.now(),
        };
      }, context);

      const handle = await api.conversation(convId, context);
      await handle.submit(
        {
          type: "input",
          content: `[WORKER_ID=${args.workerId} | ROLE=${role} | WORKSPACE=${workspaceDir}]\n${args.brief}`,
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
          thinkingLevel: "high",
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
      const transcript = await readConversationTranscript(targetId, args.maxEntries || 30);
      return { output: [{ type: "text", text: JSON.stringify({ conversationId: targetId, entries: transcript }) }] };
    },
  });

  const listWorkersTool = defineTool({
    name: "list_workers",
    description: "List all active/completed workers, cron jobs, alerts, and pending approvals.",
    replay: "safe",
    parameters: { type: "object", properties: {} },
    async execute(_args, api, context) {
      const s = (await api.snapshot(SwarmDoc, context)) ?? { workers: {}, cronJobs: {}, alerts: [], approvals: [] };
      return { output: [{ type: "text", text: JSON.stringify(s) }] };
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

  // Deterministic Rule Gates (`beforeTool` + `onYield`)
  const swarmExtension = defineExtension({
    name: "swarm-core",
    tasks: [ForeverWatchTask],
    tools: [
      spawnWorkerTool,
      requestReviewTool,
      readSiblingTool,
      listWorkersTool,
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

          // 1. Read-only roles (`btw`, `reviewer`, `planner`) can NEVER mutate files
          if (READONLY_ROLES.has(meta.role) && (call.name === "write" || call.name === "edit")) {
            return { block: `Role '${meta.role}' is strictly read-only.` };
          }
          if (meta.role === "btw" && call.name === "bash") {
            return { block: "Side-chat (/btw) cannot execute shell commands." };
          }

          // 2. Subagents are blocked from calling OptMem write tools directly
          if (meta.role !== "lead" && call.name === "memory_note") {
            return { block: "OptMem invariant: subagents must not write to OptMem; send findings to Lead via bus_send." };
          }

          // 3. Support & Social roles can NEVER execute outbound network/email sends
          if (call.name === "bash") {
            const cmd = String(call.arguments?.command || "");
            if (DESTRUCTIVE_BASH_RE.test(cmd)) {
              return {
                block: `Blocked destructive command (${cmd.slice(0, 80)}). Requires human smartcard SSH confirmation.`,
              };
            }
            if ((meta.role === "support" || meta.role === "social") && OUTBOUND_SEND_RE.test(cmd)) {
              return { block: `Role '${meta.role}' is draft-only; outbound sending is strictly prohibited.` };
            }
          }
        },
      }),
      hook(GenerationTask, {
        async onYield(answer, api, context) {
          const meta = (await api.snapshot(RoleMetaDoc, api.conversationId, context)) ?? {
            role: "lead",
            requireVerified: false,
          };
          if (meta.requireVerified) {
            const txt = extractAssistantText(answer);
            const prevRetries = yieldRetries.get(api.conversationId) || 0;
            if (!/Verified:\s*PASS/i.test(txt) && prevRetries < 2) {
              yieldRetries.set(api.conversationId, prevRetries + 1);
              return {
                continue:
                  "VERIFICATION GATE: Run your verification test via `bash` and end your response with `Verified: PASS (<test command>)`.",
              };
            }
          }

          // Deterministic self-repo GitHub backup + reload gate on VPS (/opt/pi-durable-swarm)
          if ((meta.role === "lead" || meta.role === "coder") && existsSync(join(SELF_REPO_DIR, ".git"))) {
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
          }
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
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
      },
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd || workspaceDir }),
    },
    BACKGROUND_CONTEXT,
  );
  harnessRef = harness;

  // Ensure Root Lead conversation is configured with Lead profile + V3 Caveman/ADHD instructions
  const lead = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: roleModels.lead,
      thinkingLevel: "high",
      cwd: workspaceDir,
      maxTurns: 16,
      tools: roleToolSet("lead"),
      instructions: ROLE_INSTRUCTIONS.lead,
    },
  });
  await lead.commit(async (tx) => {
    await configure(tx, lead.id, {
      model: roleModels.lead,
      thinkingLevel: "high",
      cwd: workspaceDir,
      maxTurns: 16,
      tools: roleToolSet("lead"),
      instructions: ROLE_INSTRUCTIONS.lead,
    });
    const rDoc = await tx.doc(RoleMetaDoc, lead.id);
    rDoc.role = "lead";
    rDoc.workerId = "lead";
    rDoc.requireVerified = false;
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

  return {
    harness,
    lead,
    bus,
    optmem,
    workspaceDir,
    dataDir,

    /**
     * Submit user message:
     * - `/btw ...` routes immediately to isolated read-only Side-Chat without touching Lead!
     * - `steer: true` (`Ctrl+S` live feedback) injects mid-run into Lead or named `targetWorkerId`!
     * - Multi-task prompt gets tagged via System-1 Jev so Lead fans out parallel background workers without blocking!
     */
    async chat(text, { steer = false, targetWorkerId = "lead", wait = true } = {}) {
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
        return { route: "btw", conversationId: side.id, status: settled.status, text: extractAssistantText(entry) };
      }

      let targetConv = lead;
      if (targetWorkerId !== "lead") {
        const snap = (await harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT)) ?? { workers: {} };
        const w = snap.workers?.[targetWorkerId];
        if (!w) throw new Error(`Unknown targetWorkerId: ${targetWorkerId}`);
        targetConv = await harness.conversation(w.convId, BACKGROUND_CONTEXT);
      }

      const content =
        targetWorkerId === "lead" && routeInfo.route === "fanout_parallel"
          ? `[ROUTER_HINT: fanout_parallel — spawn separate parallel workers via spawn_worker and return immediately]\n${text}`
          : text;

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
      return {
        route: routeInfo.route,
        conversationId: targetConv.id,
        status: settled.status,
        text: extractAssistantText(entry),
      };
    },

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

    async status() {
      const [swarm, inspection, usage] = await Promise.all([
        harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT),
        harness.inspect(BACKGROUND_CONTEXT),
        harness.usage(BACKGROUND_CONTEXT),
      ]);
      let totalTokens = 0;
      let costUsd = 0;
      for (const u of Object.values(usage?.models || {})) {
        totalTokens += u.totalTokens ?? 0;
        costUsd += u.cost?.total ?? 0;
      }
      return {
        swarm: swarm ?? { workers: {}, drafts: {}, alerts: [], cronJobs: {} },
        liveTasks: inspection.tasks.length,
        pendingSubmissions: inspection.submissions.length,
        usage: { totalTokens, costUsd: +costUsd.toFixed(5), byModel: usage?.models ?? {} },
      };
    },

    async waitForWorker(workerId, timeoutMs = 120_000) {
      const snap = (await harness.snapshot(SwarmDoc, BACKGROUND_CONTEXT)) ?? { workers: {} };
      const w = snap.workers?.[workerId];
      if (!w) throw new Error(`Unknown worker: ${workerId}`);
      const conv = await harness.conversation(w.convId, BACKGROUND_CONTEXT);
      await Promise.race([
        conv.waitForIdle(BACKGROUND_CONTEXT),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout waiting for ${workerId}`)), timeoutMs)),
      ]);
      return readConversationTranscript(w.convId, 30);
    },

    readTranscript: readConversationTranscript,

    async close() {
      try {
        await harness.close(BACKGROUND_CONTEXT);
      } finally {
        bus.close();
      }
    },
  };
}
