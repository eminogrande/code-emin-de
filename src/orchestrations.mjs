import { isAbsolute, relative, resolve } from "node:path";

/** Pure validation/shaping for durable orchestration & agent-orchestrator control. No model calls. */
export const DEFAULT_ORCHESTRATION_ID = "general";
export const MIN_WORKER_INTERVAL_MS = 10_000;
export const MAX_WORKER_INTERVAL_MS = 31 * 24 * 60 * 60 * 1000;
export const WORKER_ROLES = Object.freeze(["coder", "reviewer", "planner", "support", "social", "watcher"]);

export const AGENT_PRESETS = Object.freeze({
  repo: Object.freeze({
    label: "Repo / Platform",
    defaultGroup: "Repos",
    description: "Owns a Git repository/platform; edits, tests, pushes branches/main for CI/GH Actions deploy, and spawns scoped workers.",
  }),
  marketing: Object.freeze({
    label: "Marketing (Draft-Only)",
    defaultGroup: "Marketing",
    description: "Creates campaigns, copy, and schedules (LinkedIn, TikTok, X); strictly draft-only via save_draft.",
  }),
  security: Object.freeze({
    label: "Security Reviewer",
    defaultGroup: "Security",
    description: "Strictly read-only security, dependency, and config auditor; reports findings via chat or bus.",
  }),
  ops: Object.freeze({
    label: "Ops / Monitor",
    defaultGroup: "Ops",
    description: "Operations & monitoring orchestrator; runs diagnostics, watchers, and platform checks.",
  }),
  custom: Object.freeze({
    label: "Custom Agent",
    defaultGroup: "Agents",
    description: "General specialist agent-orchestrator with workspace tools and scoped workers.",
  }),
});

export const AGENT_PRESET_IDS = Object.freeze(Object.keys(AGENT_PRESETS));

function boundedString(value, label, max) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const out = value.trim();
  if (out.length > max) throw new Error(`${label} must be at most ${max} characters`);
  return out;
}

function optionalBoundedString(value, label, max) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const out = value.trim();
  if (out.length > max) throw new Error(`${label} must be at most ${max} characters`);
  return out;
}

export function validateOrchestrationName(value) {
  return boundedString(value, "name", 60);
}

/**
 * Resolve an optional agent working directory safely inside `workspaceDir` (or `/opt/pi-durable-swarm`).
 * Rejects path traversal (`..` escaping allowed roots).
 */
export function resolveSafeAgentCwd(rawCwd, workspaceDir, extraAllowedRoots = ["/opt/pi-durable-swarm"]) {
  const clean = optionalBoundedString(rawCwd, "cwd", 300);
  if (!clean) return workspaceDir;
  const base = resolve(workspaceDir);
  const candidate = isAbsolute(clean) ? resolve(clean) : resolve(base, clean);
  const allowed = [base, ...extraAllowedRoots.map((r) => resolve(r))];
  const ok = allowed.some((root) => {
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!ok) throw new Error(`cwd must stay inside ${workspaceDir}`);
  return candidate;
}

export function validateOrchestrationInput(input, workspaceDir = "") {
  const raw = typeof input === "string" ? { name: input } : (input && typeof input === "object" ? input : {});
  const name = validateOrchestrationName(raw.name);
  const presetRaw = optionalBoundedString(raw.preset, "preset", 24) || "custom";
  if (!AGENT_PRESET_IDS.includes(presetRaw)) {
    throw new Error(`Unknown preset: ${presetRaw}`);
  }
  const preset = presetRaw;
  const group = optionalBoundedString(raw.group, "group", 32) || AGENT_PRESETS[preset].defaultGroup;
  const cwd = workspaceDir ? resolveSafeAgentCwd(raw.cwd, workspaceDir) : optionalBoundedString(raw.cwd, "cwd", 300);
  const repoUrl = optionalBoundedString(raw.repoUrl, "repoUrl", 240);
  if (repoUrl && !/^(https:\/\/|git@)[^\s]+$/i.test(repoUrl)) {
    throw new Error("repoUrl must start with https:// or git@");
  }
  const instructions = optionalBoundedString(raw.instructions, "instructions", 4000);
  const provider = optionalBoundedString(raw.provider, "provider", 60);
  const modelId = optionalBoundedString(raw.modelId, "modelId", 120);
  const model = provider && modelId ? { provider, modelId } : null;
  return { name, preset, group, cwd, repoUrl, instructions, model };
}

export function validateWorkerInput({ name, role = "coder", goal, mode = "once", everyMs } = {}) {
  const cleanName = boundedString(name, "name", 60);
  const cleanGoal = boundedString(goal, "goal", 12_000);
  if (!WORKER_ROLES.includes(role)) throw new Error(`Unknown worker role: ${role}`);
  if (mode !== "once" && mode !== "recurring") throw new Error("mode must be once or recurring");
  const interval = mode === "recurring" ? Number(everyMs) : null;
  if (mode === "recurring" && (!Number.isFinite(interval) || interval < MIN_WORKER_INTERVAL_MS || interval > MAX_WORKER_INTERVAL_MS)) {
    throw new Error(`everyMs must be ${MIN_WORKER_INTERVAL_MS}–${MAX_WORKER_INTERVAL_MS}`);
  }
  return { name: cleanName, role, goal: cleanGoal, mode, everyMs: interval };
}

export function publicOrchestration(o, live) {
  const id = String(o.id);
  const preset = AGENT_PRESET_IDS.includes(o.preset) ? o.preset : "custom";
  const defaultGroup = id === DEFAULT_ORCHESTRATION_ID ? "Core" : AGENT_PRESETS[preset].defaultGroup;
  return {
    id,
    name: String(o.name),
    conversationId: o.convId,
    createdAt: Number(o.createdAt) || 0,
    state: live?.run ? "running" : live?.runFailure ? "failed" : "idle",
    preset,
    group: String(o.group || defaultGroup),
    cwd: String(o.cwd || ""),
    repoUrl: String(o.repoUrl || ""),
    instructions: String(o.instructions || ""),
    ...(o.model?.provider && o.model?.modelId ? { model: { provider: o.model.provider, modelId: o.model.modelId } } : {}),
  };
}

export function nextRunAt(worker, now = Date.now()) {
  if (worker.mode !== "recurring" || worker.enabled === false) return null;
  const base = Number(worker.lastRunAt || worker.createdAt || now);
  return base + Number(worker.everyMs);
}
